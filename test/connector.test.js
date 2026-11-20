import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { runEthanAcpTask } from '../acp-client.js'
import { apply, createEthanRunTool, formatEthanResultMarkdown } from '../index.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

test('manifest, locales, patch, and svg icon satisfy DSH bundle structure', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'dsh-ethan-connector')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(pkg.exports['.'], './index.js')
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json')
  assert.equal(pkg.exports['./icon'], './icon.svg')

  for (const locale of ['en.json', 'zh.json']) {
    const loc = JSON.parse(readFileSync(join(ROOT, 'locale', locale), 'utf8'))
    assert.ok(loc.meta?.title)
    assert.ok(loc.meta?.description)
  }

  const icon = readFileSync(join(ROOT, 'icon.svg'), 'utf8')
  assert.match(icon, /viewBox="0 0 36 36"/)
  assert.doesNotMatch(icon, /<script|<text|<style|<foreignObject/i)

  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /id:\s*ethan-connector/)
  assert.match(patch, /name:\s*['"]?dsh-ethan-connector['"]?/)
})

test('apply registers llm-pi-ai/request-headers and injects x-session-id without overriding', () => {
  const listeners = new Map()
  const injectedTools = []

  const fakeCtx = {
    on(event, fn) {
      listeners.set(event, fn)
      return () => listeners.delete(event)
    },
    inject(deps, cb) {
      assert.deepEqual(deps, ['tools'])
      cb({
        effect(fn) {
          fn()
        },
        tools: {
          register(def) {
            injectedTools.push(def)
            return () => {}
          },
        },
      })
    },
  }

  apply(fakeCtx, {})
  const handler = listeners.get('llm-pi-ai/request-headers')
  assert.equal(typeof handler, 'function')
  assert.equal(injectedTools.length, 1)
  assert.equal(injectedTools[0].name, 'ethan_run')

  // 1) Injects x-session-id when sessionId present
  const h1 = new Headers()
  const out1 = handler({ provider: 'buddy-proxy', model: 'glm-5.3', sessionId: 'dsh-s1' }, h1, () => h1)
  assert.equal(out1.get('x-session-id'), 'dsh-s1')

  // 2) Preserves explicit x-session-id
  const h2 = new Headers({ 'x-session-id': 'manual-override' })
  handler({ provider: 'buddy-proxy', model: 'glm-5.3', sessionId: 'dsh-s1' }, h2, () => h2)
  assert.equal(h2.get('x-session-id'), 'manual-override')

  // 3) No sessionId -> does not inject
  const h3 = new Headers()
  handler({ provider: 'buddy-proxy', model: 'glm-5.3' }, h3, () => h3)
  assert.equal(h3.get('x-session-id'), null)
})

test('runEthanAcpTask drives ACP handshake, permission, tool updates, and session/load', async () => {
  const mockServerScript = `
    const readline = require('node:readline');
    const rl = readline.createInterface({ input: process.stdin });
    let loaded = false;
    rl.on('line', (line) => {
      if (!line.trim()) return;
      const msg = JSON.parse(line);
      if (msg.method === 'initialize') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } }) + '\\n');
      } else if (msg.method === 'session/new') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's_mock_01' } }) + '\\n');
      } else if (msg.method === 'session/load') {
        loaded = true;
        // Replay noise from history should be discarded before prompt
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OLD' } } } }) + '\\n');
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: msg.params.sessionId } }) + '\\n');
      } else if (msg.method === 'session/prompt') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } } } }) + '\\n');
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'shell: ls', kind: 'execute', status: 'in_progress' } } }) + '\\n');
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'session/request_permission', params: { sessionId: msg.params.sessionId, options: [{ optionId: 'approve_once', kind: 'allow_once', name: 'Allow' }] } }) + '\\n');
      } else if (msg.id === 99 && msg.result) {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's_mock_01', update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc1', kind: 'execute', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'README.md' } }] } } }) + '\\n');
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's_mock_01', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: loaded ? 'resumed ok' : 'fresh ok' } } } }) + '\\n');
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: undefined, result: { stopReason: 'end_turn' } }) + '\\n');
      }
    });
  `

  const res1 = await runEthanAcpTask({
    task: 'list files',
    ethanCommand: process.execPath,
    ethanArgs: ['-e', mockServerScript],
    timeoutMs: 5000,
  })
  assert.equal(res1.sessionId, 's_mock_01')
  assert.equal(res1.stopReason, 'end_turn')
  assert.equal(res1.reply, 'fresh ok')
  assert.equal(res1.thoughtChars, 8)
  assert.deepEqual(res1.steps, [
    { id: 'tc1', title: 'shell: ls', kind: 'execute', status: 'completed', output: 'README.md' },
  ])

  const res2 = await runEthanAcpTask({
    task: 'follow up',
    sessionId: 's_mock_01',
    ethanCommand: process.execPath,
    ethanArgs: ['-e', mockServerScript],
    timeoutMs: 5000,
  })
  assert.equal(res2.sessionId, 's_mock_01')
  assert.equal(res2.reply, 'resumed ok')
})

test('tool presentation formats TUI-compatible GenericCallView and GenericResultView', () => {
  const tool = createEthanRunTool({})
  const callView = tool.presentCall({ task: 'Check repo\nsecond line', session_id: 's_123' })
  assert.equal(callView.card, 'generic')
  assert.equal(callView.kind, 'execute')
  assert.equal(callView.title, 'Ethan: Check repo')

  const value = {
    sessionId: 's_123',
    stopReason: 'end_turn',
    reply: 'Done!',
    thoughtChars: 0,
    steps: [{ id: 'tc1', title: 'file_read: a.txt', kind: 'read', status: 'completed', output: 'hello' }],
  }
  const meta = tool.output.presentationMeta({}, value)
  const resultView = tool.presentResult({}, { content: [], isError: false, meta })
  assert.equal(resultView.card, 'generic')
  assert.match(resultView.title, /1 step/)
  assert.match(resultView.content[0].text, /file_read: a\.txt/)
  assert.match(formatEthanResultMarkdown(value), /Done!/)
})
