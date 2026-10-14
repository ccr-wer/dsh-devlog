// dsh-devlog — 轮次收工时的开发日志写作者
//
// 定位：面向开发者本人的开发日志，不是 CHANGELOG，不是会话摘要。
// 读者只有开发者自己：今天干了什么、为什么这么干、踩了什么坑。
//
// 闭环（最小版）：
//   agent/turn-stopping → 切片过滤本轮事件 → 模型判断/生成 → 追加落盘
//
// 关键契约（探测实跑确认，勿改）：
//   1. agent/turn-stopping 是 serial 钩子：监听器返回值非 undefined 会拦截
//      后续监听器并让 agent.steer() 保持轮次打开。本插件 blocking=true 时
//      返回的是 resolve(undefined) 的 promise（cordis 会 await，安全）；
//      blocking=false 时立即 return undefined，后台跑。
//   2. session/event 是双参 (session, event)，post-commit fire-and-forget。
//      读本轮事件走订阅缓冲（正道）；snapshotEvents() 已 deprecated，不用。
//   3. ctx.llm.prepareCall(cfg, signal) 返回已 resolve 的冻结对象；
//      prepared.stream(options) 的 call-config 字段必须与 prepared.config
//      完全一致（callConfigEquals 逐字段比对），且一次 prepared 只能
//      dispatch 一次。正确写法：stream({ ...prepared.config, system, messages, signal })。
//   4. 消息 content 是 JSON 字符串，需 parse 成块数组再取 text。
//   5. volatile 字段（logPrompt）运行时是 ref，用 .get() 读当前值。
//      注意：host（cordis 4.0.2）不识别 volatile，用户在设置页改 prompt
//      保存后会走 fiber.update() 重启插件——新值生效，但非无感热替换。

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'

export const name = 'devlog'
export const inject = ['llm']

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ---------- 默认提示词：从 prompts/ 读，文件缺失时用内置兜底 ----------

const FALLBACK_SYSTEM = [
  '你是开发日志生成器。基于给定材料，输出一段第一人称的开发日志。',
  '写今天干了什么、为什么这么干、踩了什么坑。不写 CHANGELOG，不写会话摘要。',
  '像深夜收工后自己跟自己的复盘，允许口语和短句。以二级标题开头，不加前言不加总结。',
].join('\n')

const FALLBACK_TASK = [
  '现在是本轮工作结束的边界。基于下面材料，写一段今天的开发日志。',
  '日期：{{date}}',
  '今天已有的日志（只用于避免重复）：{{existing_log_today}}',
  '本轮上下文：{{turn_context}}',
  '本轮文件改动：{{file_changes}}',
  '相关记忆片段：{{memory_snippets}}',
  '要求：',
  '1. 只写这一轮新发生的事，已有的不重复',
  '2. 本轮没有实质开发内容就只输出：SKIP',
  '3. 输出可直接追加到日志文件末尾的 markdown 片段，以二级标题开头',
  '4. 不写日期，日期由外层统一加',
].join('\n')

function readPrompt(file, fallback) {
  try {
    const text = readFileSync(path.join(__dirname, 'prompts', file), 'utf8').trim()
    return text || fallback
  } catch {
    return fallback
  }
}

const DEFAULT_SYSTEM = readPrompt('system.md', FALLBACK_SYSTEM)
const TASK_TEMPLATE = readPrompt('task.md', FALLBACK_TASK)

// ---------- Config：设置页可编辑（volatile）+ 阻塞开关 + 模型/调试 ----------

export const Config = z.object({
  // 系统提示词（volatile，设置页可热改；host 不识别 volatile 会重启生效）
  logPrompt: z.string().default(DEFAULT_SYSTEM).volatile(),
  // 阻塞开关：true=等日志写完再关轮次；false=后台跑
  blocking: z.boolean().default(true),
  // 生成模型配置（日志加工不需要深度推理，low 足够）
  // 实测单轮生成 ~14s（low）vs ~22s（high）。注意：deepseek-flash
  // 的 efforts 白名单不含 none（传 none 会抛 UNSUPPORTED_REASONING_EFFORT，
  // 已实测），low 是能用的最低档。
  provider: z.string().default('deepseek-official'),
  model: z.string().default('deepseek-flash'),
  reasoningEffort: z.string().default('low'),
  // 调试材料落盘：always=每轮写；on-error=仅生成失败/异常时写；off=从不写
  // 默认 on-error：平时不落盘用户代码，出错时留材料便于排查
  debugDump: z.string().default('on-error'),
  // 日志输出目录。留空 = $DSH_HOME/devlog（插件默认语义）。
  // 想让产物也离开 DSH 主目录，就填绝对路径，例如 $DSH_HOME/devlog 或任意你指定的目录
  outputDir: z.string().default(''),
})

// ---------- 小工具 ----------

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

// 输出目录：outputDir 有值用它，否则落 $DSH_HOME/devlog
let DEVLOG_DIR = null

function resolveDevlogDir(config) {
  const custom = cfgVal(config && config.outputDir)
  DEVLOG_DIR = (custom && custom.trim()) || path.join(dshHome(), 'devlog')
  return DEVLOG_DIR
}

function rtLog(...args) {
  try {
    const dir = DEVLOG_DIR || path.join(dshHome(), 'devlog')
    mkdirSync(dir, { recursive: true })
    appendFileSync(path.join(dir, '.devlog-runtime.log'), new Date().toISOString() + ' ' + args.join(' ') + '\n')
  } catch {}
}

// volatile ref 与普通值兼容读取
function cfgVal(v) {
  return v && typeof v.get === 'function' ? v.get() : v
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

function fmtDate(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
}

function fmtTime(d) {
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes())
}

function clip(v, n) {
  if (v === undefined || v === null) return ''
  const s = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v) } catch { return String(v) } })()
  return s.length > n ? s.slice(0, n) + '…[+' + (s.length - n) + ' chars]' : s
}

// content 字段在订阅到的 live 事件里是真数组（sections 形态），
// 在 snapshotEvents() 的归一化形态里是 JSON 字符串——两种都兼容。
function normalizeContent(c) {
  if (Array.isArray(c)) return c
  if (typeof c === 'string') {
    try {
      const parsed = JSON.parse(c)
      if (Array.isArray(parsed)) return parsed
    } catch {}
    return [{ type: 'text', text: c }]
  }
  return []
}

function blocksText(blocks) {
  return blocks
    .map((b) => {
      if (!b || typeof b !== 'object') return ''
      if (b.type === 'reasoning') return '（思考）' + (b.text || '')
      if (b.type === 'text') return b.text || ''
      if (b.type === 'tool-call') return '（调用 ' + (b.name || '工具') + '）'
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

// assistant/message：真字段是 data.message.content（不是 data.content）
function assistantText(d) {
  const m = d && typeof d.message === 'object' && d.message ? d.message : null
  return blocksText(normalizeContent(m ? m.content : d && d.content))
}

// tool/result：结构是 data.message.content[] 里嵌 tool-result 块，再嵌一层 content[]
function toolResultText(d) {
  const m = d && typeof d.message === 'object' && d.message ? d.message : null
  const outer = normalizeContent(m ? m.content : d && d.content)
  const out = []
  for (const b of outer) {
    if (!b || typeof b !== 'object') continue
    if (b.type === 'tool-result') {
      const inner = blocksText(normalizeContent(b.content))
      out.push((b.isError ? '[ERROR] ' : '') + inner)
    } else if (b.type === 'text') {
      out.push(b.text || '')
    }
  }
  return out.join('\n')
}

// ---------- 第 2 段：过滤 ----------

// 白名单：真实用户指令、助手消息（含 reasoning）、工具调用、工具结果
const KEEP_TYPES = new Set(['assistant/message', 'tool/call', 'tool/result'])

// 双保险：plugin/skill-catalog 注入的消息 kind 不是 'user'（0.1.5-rc.1 实测），
// 但按 source.plugin / source.form 再拦一道，防未来版本把注入消息的 kind 也标成 user
function isRealUserMessage(ev) {
  const src = ev.data && ev.data.source
  if (!src || src.kind !== 'user') return false
  if (src.plugin || src.form) return false
  return true
}

function filterTurnEvents(slice) {
  return slice.filter((ev) => {
    if (!ev || !ev.type) return false
    if (ev.type === 'user/message') return isRealUserMessage(ev)
    return KEEP_TYPES.has(ev.type)
  })
}

// ---------- 第 3 段：材料组装 ----------

function serializeContext(kept, session, now, resultClip) {
  const out = ['当前时间：' + fmtTime(now)]
  try {
    if (session && session.header && session.header.cwd) out.push('工作目录：' + session.header.cwd)
  } catch {}
  out.push('')
  for (const ev of kept) {
    const d = ev.data || {}
    if (ev.type === 'user/message') {
      // 指令：保留完整
      out.push('[用户指令] ' + clip(blocksText(normalizeContent(d.content)), 2000))
    } else if (ev.type === 'assistant/message') {
      // reasoning + 判断："为什么"的来源，保留完整，任何一档裁剪都不动它
      out.push('[助手] ' + clip(assistantText(d), 2000))
    } else if (ev.type === 'tool/call') {
      // 动作：保留完整（真字段是 data.arguments，不是 data.args）
      const argsText = d.arguments !== undefined ? d.arguments : (d.args !== undefined ? d.args : '')
      out.push('[工具调用] ' + (d.name || '?') + ' ' + clip(typeof argsText === 'string' ? argsText : JSON.stringify(argsText), 2000))
    } else if (ev.type === 'tool/result') {
      // 回显：首砍对象。多数是验证输出，压掉不影响叙事
      const contentText = toolResultText(d)
      const shown = resultClip > 0
        ? clip(contentText, resultClip)
        : '（回显已省略，' + contentText.length + ' 字符）'
      out.push('[工具结果] ' + shown)
    }
  }
  return out.join('\n')
}

// 本轮文件改动摘要：优先从工具参数里抠文件路径
function extractFileChanges(kept) {
  const out = []
  for (const ev of kept) {
    if (ev.type !== 'tool/call') continue
    const d = ev.data || {}
    const name = d.name || ''
    // 真字段是 data.arguments
    const rawArgs = d.arguments !== undefined ? d.arguments : d.args
    const argsText = typeof rawArgs === 'string' ? rawArgs : (rawArgs ? JSON.stringify(rawArgs) : '')
    let args = {}
    if (typeof rawArgs === 'string') {
      try { args = JSON.parse(rawArgs) } catch {}
    } else if (rawArgs && typeof rawArgs === 'object') {
      args = rawArgs
    }
    const file = args.file_path || args.path || args.file || args.notebook_path || args.filename
    if (file) {
      out.push(name + ' → ' + file)
    } else if (/write|edit|create|delete|move|rename|patch|apply/i.test(name)) {
      out.push(name + ' :: ' + clip(argsText || '', 200))
    }
  }
  return out.join('\n')
}

// 调试用：把喂给模型的材料全文 + 原始事件结构落盘（受 debugDump 控制）
function dumpContext(text, kept, errNote) {
  try {
    const dir = DEVLOG_DIR || path.join(dshHome(), 'devlog')
    mkdirSync(dir, { recursive: true })
    let raw = ''
    if (kept) {
      raw = '\n\n===== RAW EVENTS =====\n' + kept.map((ev) => {
        let peek = ''
        try { peek = JSON.stringify(ev).slice(0, 400) } catch { peek = '<unstringifiable>' }
        return '[' + ev.type + '] keys=' + JSON.stringify(Object.keys(ev || {})) + ' :: ' + peek
      }).join('\n')
    }
    const body = text + raw + (errNote ? '\n\n===== ERROR =====\n' + errNote : '')
    writeFileSync(path.join(dir, '.devlog-context-debug.txt'), body)
  } catch {}
}

// ---------- 材料裁剪：按事件类型，不按位置 ----------
//
// 底线：user/message（指令）和 assistant/message（reasoning + 判断）是
// "为什么"和"踩坑"的来源，任何一档裁剪都不动它们。要砍只砍 tool/result
// 的回显——大多数是验证输出，压掉不影响叙事。
//
// 超预算时逐级降 tool/result 的 clip；tool/call 和 assistant 消息始终完整。
// 绝不按位置（首/尾）裁剪：中间消息里常藏着"查了半天发现是 B"这种关键绕弯。

const RESULT_CLIP_STEPS = [200, 120, 60, 0]
const CONTEXT_BUDGET = 12000

function buildTurnContext(kept, session, now) {
  let text = ''
  let used = RESULT_CLIP_STEPS[0]
  for (const step of RESULT_CLIP_STEPS) {
    text = serializeContext(kept, session, now, step)
    used = step
    if (text.length <= CONTEXT_BUDGET) break
  }
  return { text, resultClip: used }
}

function readExistingLog(dateStr) {
  try {
    return readFileSync(path.join(DEVLOG_DIR || path.join(dshHome(), 'devlog'), dateStr + '.md'), 'utf8')
  } catch {
    return ''
  }
}

// ---------- 第 4 段：生成 + 落盘 ----------

async function generateDevlog(ctx, config, payload) {
  const agent = payload.agent
  const session = agent.session
  const turn = payload.turn

  // ---- 第 2 段：从订阅缓冲切片（最后一个 turn/start<本 turn> 到末尾）----
  const buf = buffers.get(session.id) || []
  let start = -1
  for (let i = buf.length - 1; i >= 0; i--) {
    const ev = buf[i]
    if (ev.type === 'turn/start' && ev.data && ev.data.turn === turn) { start = i; break }
  }
  const slice = start >= 0 ? buf.slice(start) : buf.slice()
  const kept = filterTurnEvents(slice)

  // 粗判：本轮一个白名单事件都没有（空轮/纯系统轮），不调模型直接跳过
  if (kept.length === 0) {
    rtLog('skip-empty turn=' + turn)
    return
  }

  // ---- 第 3 段：组装材料 ----
  const now = new Date()
  const dateStr = fmtDate(now)
  const existing = readExistingLog(dateStr)
  const { text: turnContext, resultClip } = buildTurnContext(kept, session, now)
  rtLog('materials turn=' + turn + ' events=' + kept.length + ' ctxLen=' + turnContext.length + ' resultClip=' + resultClip)

  // 调试材料落盘（受 debugDump 控制）：always=每轮写；off=从不；on-error=仅出错时（见下方 catch）
  const debugDump = cfgVal(config.debugDump) || 'on-error'
  if (debugDump === 'always') dumpContext(turnContext, kept)

  const task = TASK_TEMPLATE
    .replaceAll('{{date}}', dateStr)
    .replaceAll('{{existing_log_today}}', existing || '（今天还没有日志）')
    .replaceAll('{{turn_context}}', turnContext)
    .replaceAll('{{file_changes}}', extractFileChanges(kept) || '（本轮无文件写入/编辑）')
    .replaceAll('{{memory_snippets}}', '（第一版未接入）')

  // ---- 第 4 段：调模型生成 ----
  const system = cfgVal(config.logPrompt) || DEFAULT_SYSTEM
  const cfg = {
    provider: cfgVal(config.provider) || 'deepseek-official',
    model: cfgVal(config.model) || 'deepseek-flash',
    reasoningEffort: cfgVal(config.reasoningEffort) || undefined,
  }
  try {
    const prepared = await ctx.llm.prepareCall(cfg, payload.signal)
    // 关键：options 必须带齐 prepared.config 全部字段（callConfigEquals 逐字段比对）
    const stream = prepared.stream({
      ...prepared.config,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: task }] }],
      signal: payload.signal,
    })
    let text = ''
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') text += chunk.text
    }
    text = text.trim()
    rtLog('generated turn=' + turn + ' date=' + dateStr + ' len=' + text.length)

    // 模型判断无实质内容 → 不写
    if (!text || /^SKIP\b/.test(text)) {
      rtLog('model-skip turn=' + turn)
      return
    }

    // ---- 落盘：追加到 <devlog 目录>/YYYY-MM-DD.md ----
    const dir = DEVLOG_DIR || path.join(dshHome(), 'devlog')
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, dateStr + '.md')
    const isNew = !existsSync(file)
    const body = (isNew ? '# ' + dateStr + '\n\n' : '') + text.replace(/\s+$/, '') + '\n\n'
    appendFileSync(file, body)
    rtLog('appended turn=' + turn + ' file=' + file + ' new=' + isNew)
  } catch (e) {
    // 生成/落盘失败：on-error 或 always 时把材料留盘便于排查
    if (debugDump !== 'off') {
      dumpContext(turnContext, kept, 'ERROR: ' + String((e && e.stack) || e))
    }
    throw e
  }
}

// ---------- 事件缓冲 ----------

const buffers = new Map()
const BUFFER_CAP = 3000

export function apply(ctx, config) {
  const dir = resolveDevlogDir(config)
  rtLog('applied node=' + process.version + ' dir=' + dir)

  // 正道：订阅 session/event（双参 session, event；post-commit fire-and-forget）
  ctx.on('session/event', (session, event) => {
    try {
      let buf = buffers.get(session.id)
      if (!buf) {
        buf = []
        buffers.set(session.id, buf)
      }
      buf.push(event)
      if (buf.length > BUFFER_CAP) buf.splice(0, buf.length - BUFFER_CAP)
    } catch {}
  })

  ctx.on('agent/turn-stopping', (payload) => {
    let blocking = true
    try { blocking = cfgVal(config.blocking) !== false } catch {}
    const work = generateDevlog(ctx, config, payload).catch((e) => {
      rtLog('error turn=' + (payload && payload.turn) + ' :: ' + String((e && e.stack) || e))
    })
    // serial 钩子纪律：
    //   blocking=true  → 返回 resolve(undefined) 的 promise，cordis 会 await，
    //                    落盘完成后轮次才关闭（headless 能等到产物）
    //   blocking=false → 立即 return undefined 放行，生成在后台跑（不保证完成）
    return blocking ? work : undefined
  })
}
