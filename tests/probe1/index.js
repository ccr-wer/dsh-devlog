// devlog-probe — 第一版探测脚本（临时，验证后删除）
//
// 目标：挂 agent/turn-stopping，把事件载荷完整打出来，确认能拿到：
//   1. session / agent 句柄（有哪些字段、哪些方法）
//   2. cwd（session.header.cwd）
//   3. 本轮事件序列（双路径：session/event 缓冲 + snapshotEvents）
//   4. 派生消息历史（deriveMessages，作为"摘要"候选）
//   5. ctx 上可用服务盘点（llm / shell / sessions / tools / ...）
//
// 纪律（来自官方文档 + turnsnap 参考）：
//   - agent/turn-stopping 是 serial 钩子：监听器返回非 undefined 会拦截后续
//     监听器并让 agent.steer() 保持轮次打开。本探测只观察，永远返回 undefined。
//   - 一切异常吞掉，绝不影响轮次正常关闭。

import { appendFileSync, mkdirSync } from 'node:fs'

export const name = 'devlog-probe'

const OUT_DIR = 'D:/dsh-devlog/tests/probe1'
const OUT_FILE = OUT_DIR + '/probe-output.jsonl'

try { mkdirSync(OUT_DIR, { recursive: true }) } catch {}

function clip(v, n = 500) {
  if (v === undefined) return 'undefined'
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  if (typeof s !== 'string') return String(v)
  return s.length > n ? s.slice(0, n) + '…[+' + (s.length - n) + ' chars]' : s
}

function log(tag, obj) {
  const line = JSON.stringify({ t: Date.now(), tag, ...obj })
  try { appendFileSync(OUT_FILE, line + '\n') } catch {}
  console.log('[devlog-probe] ' + tag + ' :: ' + clip(line, 700))
}

// 每个事件压成一行摘要，防爆内存
function describeEvent(ev) {
  const d = (ev && ev.data) || {}
  switch (ev.type) {
    case 'user/message':
      return { role: d.role, source: d.source, content: clip(d.content, 300) }
    case 'assistant/message':
      return { turn: d.turn, step: d.step, content: clip(d.message && d.message.content, 300), usage: d.usage, interrupted: d.interrupted }
    case 'tool/call':
      return { turn: d.turn, step: d.step, name: d.name, args: clip(d.arguments, 200) }
    case 'tool/result':
      return { turn: d.turn, step: d.step, isError: d.message && d.message.isError, content: clip(d.message && d.message.content, 200) }
    case 'turn/start':
    case 'turn/end':
      return { turn: d.turn, reason: d.reason }
    case 'step/start':
    case 'step/end':
      return { turn: d.turn, step: d.step }
    default:
      return clip(d, 200)
  }
}

// session/event 缓冲：sessionId -> { count, events[] }
const feed = new Map()

export function apply(ctx) {
  log('applied', { node: process.version, pid: process.pid })

  // 正道：订阅 session/event（emit 模式，post-commit fire-and-forget）
  ctx.on('session/event', (session, event) => {
    try {
      let rec = feed.get(session.id)
      if (!rec) {
        rec = { count: 0, events: [] }
        feed.set(session.id, rec)
      }
      rec.count++
      rec.events.push({ seq: event.seq, type: event.type, time: event.time, data: describeEvent(event) })
    } catch (e) {
      log('feed-error', { error: String(e) })
    }
  })

  ctx.on('agent/turn-stopping', (payload) => {
    try {
      log('turn-stopping', {
        payloadKeys: Object.keys(payload || {}),
        turn: payload && payload.turn,
      })

      const agent = payload && payload.agent
      const signal = payload && payload.signal
      log('agent-handle', {
        agentKeys: agent ? Object.keys(agent) : null,
        id: agent && agent.id,
        status: agent && agent.status,
        options: agent && agent.options,
        signalType: signal === null ? 'null' : typeof signal,
        signalIsAbortSignal: typeof AbortSignal !== 'undefined' && signal instanceof AbortSignal,
        signalAborted: signal && signal.aborted,
      })

      const session = agent && agent.session
      log('session-handle', {
        sessionKeys: session ? Object.keys(session) : null,
        id: session && session.id,
        seq: session && session.seq,
        header: session && session.header,
        hasSnapshotEvents: typeof (session && session.snapshotEvents),
        hasDeriveMessages: typeof (session && session.deriveMessages),
      })

      // 路径 A：snapshotEvents（当前 0.1.5-rc.1 运行时存在；master 文档已标 deprecated）
      try {
        const all = session.snapshotEvents()
        let start = 0
        for (let i = all.length - 1; i >= 0; i--) {
          const ev = all[i]
          if (ev.type === 'turn/start' && ev.data && ev.data.turn === payload.turn) { start = i; break }
        }
        const slice = all.slice(start)
        log('turn-events-snapshot', {
          turn: payload.turn,
          total: all.length,
          startIdx: start,
          sliceCount: slice.length,
          events: slice.map(describeEvent),
        })
      } catch (e) {
        log('turn-events-snapshot-failed', { error: String(e) })
      }

      // 路径 B：session/event 缓冲
      const rec = session && feed.get(session.id)
      log('turn-events-feed', {
        sessionId: session && session.id,
        bufferedCount: rec ? rec.count : 0,
        lastEvents: rec ? rec.events.slice(-40) : [],
      })

      // 摘要候选：deriveMessages
      try {
        const msgs = session.deriveMessages()
        log('derived-messages', {
          count: msgs.length,
          tail: msgs.slice(-8).map((m) => ({ role: m.role, content: clip(m.content, 150) })),
        })
      } catch (e) {
        log('derive-messages-failed', { error: String(e) })
      }

      // ctx 服务盘点
      const names = ['shell', 'sessions', 'llm', 'tools', 'agents', 'agentLoop', 'systemPrompt', 'sandboxPolicy']
      const found = {}
      for (const k of names) {
        try { found[k] = ctx[k] === undefined ? 'absent' : typeof ctx[k] } catch { found[k] = 'throw' }
      }
      try { found.ctxOwnKeys = Object.keys(ctx) } catch { found.ctxOwnKeys = 'throw' }
      log('ctx-services', found)

      log('feed-sessions', { sessions: Array.from(feed.keys()) })
    } catch (e) {
      log('listener-error', { error: String(e), stack: String(e && e.stack) })
    }
    // 故意不返回值：不拦截 serial 链，不 steer，让轮次正常关闭
  })
}
