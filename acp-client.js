import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'

const MAX_STEP_OUTPUT_CHARS = 600
const MAX_STEPS_TRACKED = 64

function truncate(text, maxChars) {
  const s = String(text ?? '')
  if (s.length <= maxChars) return s
  return `${s.slice(0, maxChars)}\n... [truncated]`
}

function resolveEthanExecutable(configured) {
  if (typeof configured === 'string' && configured.trim()) {
    return configured.trim()
  }
  const envBin = process.env.ETHAN_BIN?.trim()
  if (envBin && existsSync(envBin)) {
    return envBin
  }
  return 'ethan'
}

function pickPermissionOutcome(params, autoApprove) {
  const options = Array.isArray(params?.options) ? params.options : []
  if (!autoApprove) {
    const reject = options.find((opt) => opt?.kind === 'reject_once' || opt?.kind === 'reject_always')
    if (reject?.optionId) {
      return { outcome: { outcome: 'selected', optionId: reject.optionId } }
    }
    return { outcome: { outcome: 'cancelled' } }
  }
  // 优先选单次放行，其次会话内放行（与 ethan/acp_server/consent.py 保持保守一致）
  const preferred =
    options.find((opt) => opt?.kind === 'allow_once') ??
    options.find((opt) => opt?.kind === 'allow_always') ??
    options[0]
  if (preferred?.optionId) {
    return { outcome: { outcome: 'selected', optionId: preferred.optionId } }
  }
  return { outcome: { outcome: 'cancelled' } }
}

function extractUpdateText(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    if (item.type === 'content' && item.content && typeof item.content === 'object') {
      if (item.content.type === 'text' && typeof item.content.text === 'string') {
        parts.push(item.content.text)
      }
    } else if (item.type === 'text' && typeof item.text === 'string') {
      parts.push(item.text)
    }
  }
  return parts.join('\n').trim()
}

/**
 * 通过 `ethan acp` 执行一轮任务，收集工具调用步骤、思考片段与最终回复。
 *
 * 协议对齐 ethan/acp_server/server.py 与 mapping.py：
 *   initialize -> session/new (或 session/load) -> session/prompt
 *   期间处理 session/update 通知与 session/request_permission 请求。
 */
export async function runEthanAcpTask({
  task,
  sessionId,
  cwd,
  signal,
  ethanCommand,
  ethanArgs = ['acp'],
  autoApprove = true,
  timeoutMs = 600_000,
}) {
  if (signal?.aborted) {
    throw new Error('ethan_run aborted before start')
  }

  const command = resolveEthanExecutable(ethanCommand)
  const args = Array.isArray(ethanArgs) && ethanArgs.length > 0 ? ethanArgs : ['acp']
  const effectiveCwd = cwd || process.cwd()

  const child = spawn(command, args, {
    cwd: effectiveCwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  })

  let nextId = 1
  const pending = new Map()
  const stderrChunks = []
  const stepsById = new Map()
  const stepOrder = []
  const replyChunks = []
  let thoughtChars = 0
  let activeSessionId = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : ''
  let settled = false

  child.stderr.on('data', (chunk) => {
    if (stderrChunks.length < 20) {
      stderrChunks.push(chunk.toString('utf8'))
    }
  })

  const sendLine = (obj) => {
    if (child.stdin.writable) {
      child.stdin.write(`${JSON.stringify(obj)}\n`)
    }
  }

  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject, method })
      sendLine({ jsonrpc: '2.0', id, method, params })
    })

  const notify = (method, params) => {
    sendLine({ jsonrpc: '2.0', method, params })
  }

  const failAll = (err) => {
    if (settled) return
    settled = true
    for (const entry of pending.values()) {
      entry.reject(err)
    }
    pending.clear()
  }

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    let msg
    try {
      msg = JSON.parse(trimmed)
    } catch {
      return
    }

    // 1) JSON-RPC response to our request
    if (Object.hasOwn(msg, 'id') && msg.id !== null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) {
        const errMsg = msg.error.message || JSON.stringify(msg.error)
        reject(new Error(`ACP ${msg.error.code ?? 'error'}: ${errMsg}`))
      } else {
        resolve(msg.result)
      }
      return
    }

    // 2) Server -> Client request (session/request_permission)
    if (Object.hasOwn(msg, 'id') && typeof msg.method === 'string') {
      if (msg.method === 'session/request_permission') {
        sendLine({
          jsonrpc: '2.0',
          id: msg.id,
          result: pickPermissionOutcome(msg.params, autoApprove),
        })
      } else {
        sendLine({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: `Unsupported method: ${msg.method}` },
        })
      }
      return
    }

    // 3) Server -> Client notification (session/update)
    if (msg.method === 'session/update' && msg.params?.update) {
      const u = msg.params.update
      switch (u.sessionUpdate) {
        case 'agent_message_chunk': {
          const text = u.content?.type === 'text' ? u.content.text : ''
          if (text) replyChunks.push(text)
          break
        }
        case 'agent_thought_chunk': {
          const text = u.content?.type === 'text' ? u.content.text : ''
          if (text) thoughtChars += text.length
          break
        }
        case 'tool_call': {
          const tcId = String(u.toolCallId || `tc_${stepOrder.length + 1}`)
          if (!stepsById.has(tcId) && stepOrder.length < MAX_STEPS_TRACKED) {
            stepOrder.push(tcId)
          }
          stepsById.set(tcId, {
            id: tcId,
            title: String(u.title || tcId),
            kind: String(u.kind || 'other'),
            status: String(u.status || 'in_progress'),
            output: '',
          })
          break
        }
        case 'tool_call_update': {
          const tcId = String(u.toolCallId || '')
          if (!tcId) break
          const existing = stepsById.get(tcId) ?? {
            id: tcId,
            title: String(u.title || tcId),
            kind: String(u.kind || 'other'),
            status: 'in_progress',
            output: '',
          }
          if (!stepsById.has(tcId) && stepOrder.length < MAX_STEPS_TRACKED) {
            stepOrder.push(tcId)
          }
          if (u.title) existing.title = String(u.title)
          if (u.kind) existing.kind = String(u.kind)
          if (u.status) existing.status = String(u.status)
          const outText = extractUpdateText(u.content)
          if (outText) existing.output = truncate(outText, MAX_STEP_OUTPUT_CHARS)
          stepsById.set(tcId, existing)
          break
        }
        default:
          break
      }
    }
  })

  child.on('error', (err) => {
    failAll(new Error(`Failed to launch "${command}": ${err.message}`))
  })

  child.on('close', (code, sig) => {
    const tail = stderrChunks.join('').trim()
    const reason = tail ? `: ${truncate(tail, 400)}` : ''
    failAll(new Error(`ethan acp exited unexpectedly (code=${code}, signal=${sig})${reason}`))
  })

  let timeoutTimer
  let killTimer
  const abortController = new AbortController()

  const onAbort = () => {
    if (activeSessionId) {
      try {
        notify('session/cancel', { sessionId: activeSessionId })
      } catch {
        // ignore write errors during teardown
      }
    }
    killTimer = setTimeout(() => {
      if (!child.killed) child.kill('SIGTERM')
    }, 300)
    failAll(new Error('ethan_run cancelled'))
  }

  if (signal) {
    signal.addEventListener('abort', onAbort, { once: true })
  }
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      abortController.abort()
      if (activeSessionId) {
        try {
          notify('session/cancel', { sessionId: activeSessionId })
        } catch {
          // ignore
        }
      }
      if (!child.killed) child.kill('SIGTERM')
      failAll(new Error(`ethan_run timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  }

  try {
    await request('initialize', { protocolVersion: 1 })
    if (activeSessionId) {
      await request('session/load', { sessionId: activeSessionId, cwd: effectiveCwd })
      // session/load replays history through session/update; drop replayed chunks before sending prompt
      replyChunks.length = 0
      stepsById.clear()
      stepOrder.length = 0
      thoughtChars = 0
    } else {
      const created = await request('session/new', { cwd: effectiveCwd })
      activeSessionId = String(created?.sessionId || '')
      if (!activeSessionId) {
        throw new Error('ethan acp did not return a sessionId')
      }
    }

    const promptRes = await request('session/prompt', {
      sessionId: activeSessionId,
      prompt: [{ type: 'text', text: String(task) }],
    })

    const steps = stepOrder.map((id) => stepsById.get(id)).filter(Boolean)
    return {
      sessionId: activeSessionId,
      stopReason: String(promptRes?.stopReason || 'end_turn'),
      reply: replyChunks.join(''),
      thoughtChars,
      steps,
    }
  } finally {
    settled = true
    if (timeoutTimer) clearTimeout(timeoutTimer)
    if (killTimer) clearTimeout(killTimer)
    if (signal) signal.removeEventListener('abort', onAbort)
    rl.close()
    try {
      child.stdin.end()
    } catch {
      // ignore
    }
    if (!child.killed && child.exitCode === null) {
      child.kill('SIGTERM')
    }
  }
}
