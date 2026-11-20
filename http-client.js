import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MAX_STEP_OUTPUT_CHARS = 600
const MAX_STEPS_TRACKED = 64

function truncate(text, maxChars) {
  const s = String(text ?? '')
  if (s.length <= maxChars) return s
  return `${s.slice(0, maxChars)}\n... [truncated]`
}

function readAuthTokenFromConfig(configPath) {
  const path = configPath || join(homedir(), '.ethan', 'config.yaml')
  if (!existsSync(path)) return ''
  try {
    const raw = readFileSync(path, 'utf8')
    const match = raw.match(/^\s*auth_token\s*:\s*['"]?([^'"#\r\n]+)['"]?/m)
    return match ? match[1].trim() : ''
  } catch {
    return ''
  }
}

export function resolveEthanHttpConfig(config = {}) {
  const rawUrl =
    (typeof config.ethanUrl === 'string' && config.ethanUrl.trim()) ||
    process.env.ETHAN_URL?.trim() ||
    'http://127.0.0.1:8900'
  const baseUrl = rawUrl.replace(/\/+$/, '')

  const authToken =
    (typeof config.authToken === 'string' && config.authToken.trim()) ||
    process.env.ETHAN_AUTH_TOKEN?.trim() ||
    readAuthTokenFromConfig(config.ethanConfigPath)

  return { baseUrl, authToken }
}

export async function isEthanHttpAvailable(config = {}, timeoutMs = 800) {
  const { baseUrl, authToken } = resolveEthanHttpConfig(config)
  if (!authToken) return false
  try {
    const res = await fetch(`${baseUrl}/api/health`, {
      headers: { Authorization: `Bearer ${authToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * 通过 Ethan HTTP `/api/chat` (SSE) 执行一轮任务，收集工具步骤与最终回复。
 * 复用本机已启动的 Ethan 服务（默认 http://127.0.0.1:8900，自动读取 ~/.ethan/config.yaml 的 auth_token）。
 */
export async function runEthanHttpTask({
  task,
  sessionId,
  cwd,
  signal,
  ethanUrl,
  authToken,
  ethanConfigPath,
  autoApprove = true,
  channel = 'dsh',
  timeoutMs = 600_000,
}) {
  if (signal?.aborted) {
    throw new Error('ethan_run aborted before start')
  }

  const resolved = resolveEthanHttpConfig({ ethanUrl, authToken, ethanConfigPath })
  if (!resolved.authToken) {
    throw new Error('Ethan auth_token not configured and not found in ~/.ethan/config.yaml')
  }

  const controller = new AbortController()
  const onOuterAbort = () => controller.abort(signal.reason)
  if (signal) {
    signal.addEventListener('abort', onOuterAbort, { once: true })
  }
  const timer =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => controller.abort(new Error(`ethan_run timed out after ${timeoutMs}ms`)), timeoutMs)
      : undefined

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${resolved.authToken}`,
  }
  const sid = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : ''

  const body = {
    messages: [{ role: 'user', content: String(task) }],
    stream: true,
    auto_consent: Boolean(autoApprove),
    channel,
    ...(sid ? { session_id: sid } : {}),
    ...(cwd ? { runtime_context: `Working directory: ${cwd}` } : {}),
  }

  const stepsById = new Map()
  const stepOrder = []
  const replyChunks = []
  let activeSessionId = sid
  let streamError = ''
  let stopReason = 'end_turn'

  try {
    const res = await fetch(`${resolved.baseUrl}/api/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      throw new Error(`Ethan HTTP ${res.status}: ${truncate(errBody, 300)}`)
    }

    const headerSid = res.headers.get('x-session-id')
    if (headerSid && headerSid.trim()) {
      activeSessionId = headerSid.trim()
    }

    if (!res.body) {
      throw new Error('Ethan HTTP response has no body')
    }

    const decoder = new TextDecoder()
    let buffer = ''

    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true })
      const frames = buffer.split(/\r?\n\r?\n/)
      buffer = frames.pop() ?? ''

      for (const frame of frames) {
        const dataLines = frame
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
        if (dataLines.length === 0) continue

        let evt
        try {
          evt = JSON.parse(dataLines.join('\n'))
        } catch {
          continue
        }

        if (typeof evt.session_id === 'string' && evt.session_id) {
          activeSessionId = evt.session_id
        }

        if (typeof evt.content === 'string' && evt.content) {
          replyChunks.push(evt.content)
          continue
        }

        if (typeof evt.tool === 'string' && evt.tool) {
          const tcId = String(evt.id || `tc_${evt.tool}_${stepOrder.length + 1}`)
          if (!stepsById.has(tcId) && stepOrder.length < MAX_STEPS_TRACKED) {
            stepOrder.push(tcId)
          }
          const existing = stepsById.get(tcId) ?? {
            id: tcId,
            title: evt.args ? `${evt.tool}: ${evt.args}` : evt.tool,
            kind: 'execute',
            status: 'in_progress',
            output: '',
          }
          if (evt.state === 'start') {
            existing.status = 'in_progress'
            if (evt.args) existing.title = `${evt.tool}: ${evt.args}`
          } else if (evt.state === 'done' || evt.state === 'error') {
            existing.status = evt.state === 'error' ? 'failed' : 'completed'
            const out = evt.result_preview || evt.result_detail || ''
            if (out) existing.output = truncate(out, MAX_STEP_OUTPUT_CHARS)
          }
          stepsById.set(tcId, existing)
          continue
        }

        if (typeof evt.error === 'string' && evt.error) {
          streamError = evt.error
          stopReason = 'error'
          continue
        }

        if (evt.stopped) {
          stopReason = 'cancelled'
        }
      }
    }

    const steps = stepOrder.map((id) => stepsById.get(id)).filter(Boolean)
    const reply = replyChunks.join('')
    if (streamError && !reply) {
      throw new Error(streamError)
    }

    return {
      sessionId: activeSessionId,
      stopReason,
      reply: streamError ? `${reply}\n\n[error] ${streamError}` : reply,
      thoughtChars: 0,
      steps,
    }
  } finally {
    if (timer) clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onOuterAbort)
    if (controller.signal.aborted && activeSessionId && signal?.aborted) {
      // Best-effort cancel on Ethan server when caller aborts
      fetch(`${resolved.baseUrl}/api/chat/${encodeURIComponent(activeSessionId)}/stop`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${resolved.authToken}` },
      }).catch(() => {})
    }
  }
}
