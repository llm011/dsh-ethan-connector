import { runEthanAcpTask } from './acp-client.js'
import { isEthanHttpAvailable, runEthanHttpTask } from './http-client.js'

const STEP_STATUS_ICON = {
  completed: '[ok]',
  failed: '[err]',
  in_progress: '[..]',
}

function firstLine(text, maxLen = 60) {
  const line = String(text ?? '').trim().split(/\r?\n/, 1)[0] ?? ''
  return line.length > maxLen ? `${line.slice(0, maxLen)}…` : line
}

export function formatEthanResultMarkdown(value) {
  if (!value || typeof value !== 'object') return ''
  const lines = []
  const sessionId = value.sessionId ? `session \`${value.sessionId}\`` : 'session unknown'
  const steps = Array.isArray(value.steps) ? value.steps : []
  lines.push(`**Ethan Agent** (${sessionId}, ${steps.length} step${steps.length === 1 ? '' : 's'}, stop: ${value.stopReason || 'end_turn'})`)

  if (steps.length > 0) {
    lines.push('')
    lines.push('**Steps**')
    for (const step of steps) {
      const icon = STEP_STATUS_ICON[step.status] ?? `[${step.status || '?'}]`
      const kind = step.kind ? `(${step.kind}) ` : ''
      lines.push(`- ${icon} ${kind}${step.title}`)
      if (step.output) {
        const preview = String(step.output).trim().split(/\r?\n/).slice(0, 3).join(' / ')
        lines.push(`  > ${preview}`)
      }
    }
  }

  const reply = String(value.reply ?? '').trim()
  if (reply) {
    lines.push('')
    lines.push(reply)
  }
  return lines.join('\n')
}

export function createEthanRunTool(config = {}) {
  return {
    name: 'ethan_run',
    description:
      'Delegate a task to Ethan Agent over ACP and return its session ID, executed tool steps, and final response. Pass session_id to continue an earlier Ethan conversation.',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Task or prompt to send to Ethan Agent.',
        },
        session_id: {
          type: 'string',
          description: 'Optional Ethan session ID to resume and continue an existing session.',
        },
        cwd: {
          type: 'string',
          description: 'Optional working directory for Ethan Agent. Defaults to the current workspace.',
        },
        timeout_ms: {
          type: 'integer',
          description: 'Optional timeout in milliseconds for this task.',
        },
      },
      required: ['task'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          stopReason: { type: 'string' },
          reply: { type: 'string' },
          thoughtChars: { type: 'integer' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                kind: { type: 'string' },
                status: { type: 'string' },
                output: { type: 'string' },
              },
              required: ['id', 'title', 'kind', 'status', 'output'],
              additionalProperties: false,
            },
          },
        },
        required: ['sessionId', 'stopReason', 'reply', 'thoughtChars', 'steps'],
        additionalProperties: false,
      },
      render(_args, value) {
        return [{ type: 'text', text: formatEthanResultMarkdown(value) }]
      },
      presentationMeta(_args, value) {
        return value
      },
    },
    presentCall(args) {
      const a = args && typeof args === 'object' ? args : {}
      const titleSuffix = firstLine(a.task)
      return {
        card: 'generic',
        kind: 'execute',
        title: titleSuffix ? `Ethan: ${titleSuffix}` : 'Ethan Agent',
        ...(a.session_id || a.cwd
          ? {
              rawInput: {
                ...(a.session_id ? { session_id: a.session_id } : {}),
                ...(a.cwd ? { cwd: a.cwd } : {}),
              },
            }
          : {}),
      }
    },
    presentResult(_args, result) {
      if (result?.isError) {
        return undefined
      }
      const meta = result?.meta
      if (meta && typeof meta === 'object') {
        const steps = Array.isArray(meta.steps) ? meta.steps : []
        const sid = meta.sessionId ? ` · ${String(meta.sessionId).slice(0, 14)}` : ''
        return {
          card: 'generic',
          title: `Ethan (${steps.length} step${steps.length === 1 ? '' : 's'}${sid})`,
          content: [{ type: 'text', text: formatEthanResultMarkdown(meta) }],
        }
      }
      return undefined
    },
    async execute(args, exec) {
      const a = args && typeof args === 'object' ? args : {}
      const timeoutMs =
        typeof a.timeout_ms === 'number' && a.timeout_ms > 0
          ? a.timeout_ms
          : typeof config.timeoutMs === 'number' && config.timeoutMs > 0
            ? config.timeoutMs
            : 600_000
      const mode = typeof config.transport === 'string' ? config.transport : 'auto'
      const useHttp =
        mode === 'http'
          ? true
          : mode === 'acp'
            ? false
            : await isEthanHttpAvailable(config)

      if (useHttp) {
        return runEthanHttpTask({
          task: a.task,
          sessionId: a.session_id,
          cwd: a.cwd,
          signal: exec?.signal,
          ethanUrl: config.ethanUrl,
          authToken: config.authToken,
          ethanConfigPath: config.ethanConfigPath,
          autoApprove: config.autoApprove !== false,
          timeoutMs,
        })
      }

      return runEthanAcpTask({
        task: a.task,
        sessionId: a.session_id,
        cwd: a.cwd,
        signal: exec?.signal,
        ethanCommand: config.ethanCommand,
        ethanArgs: config.ethanArgs,
        autoApprove: config.autoApprove !== false,
        timeoutMs,
      })
    },
  }
}

export function apply(ctx, config = {}) {
  if (config.injectSessionHeader !== false) {
    ctx.on('llm-pi-ai/request-headers', (request, headers, next) => {
      const sid = request?.sessionId
      if (typeof sid === 'string' && sid && !headers.has('x-session-id')) {
        headers.set('x-session-id', sid)
      }
      return next()
    })
  }

  if (config.enableTool !== false) {
    ctx.inject(['tools'], (child) => {
      child.effect(() => child.tools.register(createEthanRunTool(config)))
    })
  }
}
