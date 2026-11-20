import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { isEthanHttpAvailable, resolveEthanHttpConfig, runEthanHttpTask } from '../http-client.js'

function startMockEthan(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` })
    })
  })
}

test('resolveEthanHttpConfig reads auth_token from config.yaml', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ethan-cfg-'))
  try {
    const cfgPath = join(dir, 'config.yaml')
    writeFileSync(cfgPath, "defaults:\n  agent_name: 小艺\nserver:\n  auth_token: abc123token\n")
    const resolved = resolveEthanHttpConfig({ ethanConfigPath: cfgPath, ethanUrl: 'http://127.0.0.1:9999/' })
    assert.equal(resolved.baseUrl, 'http://127.0.0.1:9999')
    assert.equal(resolved.authToken, 'abc123token')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runEthanHttpTask parses SSE content/tool events and session header', async () => {
  const { server, url } = await startMockEthan((req, res) => {
    if (req.url === '/api/chat' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        const parsed = JSON.parse(body)
        assert.equal(parsed.stream, true)
        assert.equal(parsed.auto_consent, true)
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'X-Session-Id': 's_http_01',
        })
        const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
        send({ tool: 'weather', args: '北京', state: 'start', id: 'tc1' })
        send({ tool: 'weather', args: '北京', state: 'done', id: 'tc1', result_preview: '晴 1°C' })
        send({ content: '北京今天晴，' })
        send({ content: '1°C。' })
        send({ done: true, usage: {} })
        res.end()
      })
      return
    }
    res.writeHead(404)
    res.end()
  })

  try {
    const result = await runEthanHttpTask({
      task: '查天气',
      ethanUrl: url,
      authToken: 'test-token',
      timeoutMs: 5000,
    })
    assert.equal(result.sessionId, 's_http_01')
    assert.equal(result.reply, '北京今天晴，1°C。')
    assert.equal(result.stopReason, 'end_turn')
    assert.deepEqual(result.steps, [
      { id: 'tc1', title: 'weather: 北京', kind: 'execute', status: 'completed', output: '晴 1°C' },
    ])
  } finally {
    server.close()
  }
})

test('runEthanHttpTask resumes session and surfaces stream error', async () => {
  const { server, url } = await startMockEthan((req, res) => {
    if (req.url === '/api/chat' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        const parsed = JSON.parse(body)
        assert.equal(parsed.session_id, 's_existing')
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ error: '模型调用失败' })}\n\n`)
        res.end()
      })
      return
    }
    res.writeHead(404)
    res.end()
  })

  try {
    await assert.rejects(
      runEthanHttpTask({ task: '继续', sessionId: 's_existing', ethanUrl: url, authToken: 't', timeoutMs: 5000 }),
      /模型调用失败/,
    )
  } finally {
    server.close()
  }
})

test('isEthanHttpAvailable probes /api/health with bearer token', async () => {
  const { server, url } = await startMockEthan((req, res) => {
    if (req.url === '/api/health') {
      if (req.headers.authorization === 'Bearer good-token') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok' }))
      } else {
        res.writeHead(401)
        res.end()
      }
      return
    }
    res.writeHead(404)
    res.end()
  })

  try {
    assert.equal(await isEthanHttpAvailable({ ethanUrl: url, authToken: 'good-token' }), true)
    assert.equal(await isEthanHttpAvailable({ ethanUrl: url, authToken: 'bad-token' }), false)
    assert.equal(await isEthanHttpAvailable({ ethanUrl: 'http://127.0.0.1:1', authToken: 'x' }), false)
  } finally {
    server.close()
  }
})
