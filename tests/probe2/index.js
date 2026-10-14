// devlog-probe2 — 正式版动工前的两个半确认：
//   1. ctx.llm.prepareCall(config, signal) 的返回值形态 + 怎么拿到响应文本
//   2. user/message 事件 source 对象完整字段（真实指令 vs plugin/skill-catalog 注入）
//   3. Config volatile 字段在运行时的形态（config.logPrompt 是不是 ref、.get() 好不好用）
//
// 纪律不变：serial 监听器只观察，永远返回 undefined；异常全吞。

import { appendFileSync, mkdirSync } from 'node:fs'
import z from '@deepseek-ai/schemastery'

export const name = 'devlog-probe2'
export const inject = ['llm']

export const Config = z.object({
  logPrompt: z.string().default('你是开发日志生成器（probe2 占位默认值）。').volatile(),
})

const OUT_FILE = 'D:/dsh-devlog/tests/probe2/probe2-output.jsonl'
try { mkdirSync('D:/dsh-devlog/tests/probe2', { recursive: true }) } catch {}

function clip(v, n = 600) {
  if (v === undefined) return 'undefined'
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  if (typeof s !== 'string') return String(v)
  return s.length > n ? s.slice(0, n) + '…[+' + (s.length - n) + ' chars]' : s
}

function log(tag, obj) {
  const line = JSON.stringify({ t: Date.now(), tag, ...obj })
  try { appendFileSync(OUT_FILE, line + '\n') } catch {}
  console.log('[devlog-probe2] ' + tag + ' :: ' + clip(line, 700))
}

// ---- 确认 3：Config volatile 字段形态 ----
function inspectConfig(config) {
  const out = { configType: typeof config, configKeys: null }
  try { out.configKeys = config ? Object.keys(config) : null } catch { out.configKeys = 'throw' }
  try {
    const lp = config && config.logPrompt
    out.logPrompt = {
      type: typeof lp,
      hasGet: typeof (lp && lp.get),
      getResult: typeof (lp && lp.get) === 'function' ? clip(lp.get(), 100) : undefined,
      ownKeys: lp && typeof lp === 'object' ? Object.keys(lp) : undefined,
      symbols: lp && typeof lp === 'object' ? Object.getOwnPropertySymbols(lp).map(String) : undefined,
      isVolatileBrand: lp && typeof lp === 'object' ? Object.getOwnPropertySymbols(lp).some((s) => String(s).includes('olatile')) : undefined,
    }
  } catch (e) {
    out.logPromptError = String(e)
  }
  log('config-shape', out)
}

export function apply(ctx, config) {
  log('applied', { node: process.version })
  inspectConfig(config)

  ctx.on('agent/turn-stopping', async (payload) => {
    try {
      const agent = payload.agent
      const session = agent.session
      log('turn', { turn: payload.turn, sessionId: session.id })

      // ---- 确认 2：本轮所有 user/message 的完整 source ----
      const all = session.snapshotEvents()
      let start = 0
      for (let i = all.length - 1; i >= 0; i--) {
        const ev = all[i]
        if (ev.type === 'turn/start' && ev.data && ev.data.turn === payload.turn) { start = i; break }
      }
      const slice = all.slice(start)
      const userMsgs = slice.filter((ev) => ev.type === 'user/message')
      log('user-messages', {
        count: userMsgs.length,
        items: userMsgs.map((ev) => ({
          seq: ev.seq,
          role: ev.data.role,
          source: ev.data.source,               // 完整 source 对象，原样
          sourceKeys: ev.data.source ? Object.keys(ev.data.source) : null,
          contentBlockTypes: Array.isArray(ev.data.content) ? ev.data.content.map((b) => b.type) : typeof ev.data.content,
          contentHead: clip(Array.isArray(ev.data.content) ? ev.data.content.map((b) => b.text || '').join('') : ev.data.content, 200),
        })),
      })
      // 顺带：本轮事件类型序列（对照噪音分布）
      log('turn-event-types', { types: slice.map((ev) => ev.type) })

      // ---- 确认 1：prepareCall 返回值 + 真调一次 ----
      const cfg = { provider: 'deepseek-official', model: 'deepseek-flash' }
      const t0 = Date.now()
      const prepared = await ctx.llm.prepareCall(cfg, payload.signal)
      log('prepareCall-return', {
        ms: Date.now() - t0,
        type: typeof prepared,
        isThenable: typeof (prepared && prepared.then),
        keys: prepared && typeof prepared === 'object' ? Object.keys(prepared) : null,
        config: prepared && prepared.config,
        hasStreamFn: typeof (prepared && prepared.stream),
        retryPolicyType: typeof (prepared && prepared.retryPolicy),
        contextKeys: prepared && prepared.context && typeof prepared.context === 'object' ? Object.keys(prepared.context) : undefined,
        systemPromptUpdate: prepared && prepared.systemPromptUpdate,
        adapterDefaults: prepared && prepared.adapterDefaults,
      })

      const t1 = Date.now()
      const parts = []
      const chunkTypes = []
      // 关键：stream(options) 的 call-config 字段必须与 prepared.config 完全一致
      // （callConfigEquals 逐字段比对），且一次 prepared 只能 dispatch 一次
      const stream = prepared.stream({
        ...prepared.config,
        system: 'You are a probe. Reply with exactly: PROBE-OK',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'say PROBE-OK' }] }],
        signal: payload.signal,
      })
      for await (const chunk of stream) {
        chunkTypes.push(chunk.type)
        if (chunk.type === 'text-delta') parts.push(chunk.text)
        if (chunk.type === 'finish') parts.push('<finish:' + chunk.reason + '>')
        if (chunk.type === 'usage') parts.push('<usage:' + JSON.stringify(chunk.usage) + '>')
      }
      log('stream-result', {
        ms: Date.now() - t1,
        text: parts.join(''),
        chunkTypes: [...new Set(chunkTypes)],
        chunkCount: chunkTypes.length,
      })
    } catch (e) {
      log('listener-error', { error: String(e), stack: String(e && e.stack) })
    }
    // 故意不返回值
  })
}
