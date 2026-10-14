import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'

import { ApiClient, ApiClientError } from '../src/main/api/api-client.ts'

const meta = { timestamp: '2026-10-04T00:00:00.000Z' }
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' }
})

test('joins an API base path with a relative endpoint and parses data', async () => {
  let requested = ''
  const client = new ApiClient('http://127.0.0.1:3000/api/', async (input) => {
    requested = String(input)
    return reply({ success: true, data: { sessionId: 's1' }, meta })
  })
  const data = await client.request('ftp/sessions', { method: 'POST' }, z.object({ sessionId: z.string() }))
  assert.equal(requested, 'http://127.0.0.1:3000/api/ftp/sessions')
  assert.deepEqual(data, { sessionId: 's1' })
})

test('preserves encoded query parameters in a joined endpoint', async () => {
  let requested = ''
  const client = new ApiClient('http://127.0.0.1:3000/api', async (input) => {
    requested = String(input)
    return reply({ success: true, data: [], meta: { ...meta, total: 0 } })
  })
  await client.request('ftp/sessions/s1/files?path=%2Fa%20b%26c', {}, z.array(z.unknown()))
  assert.equal(requested, 'http://127.0.0.1:3000/api/ftp/sessions/s1/files?path=%2Fa%20b%26c')
})

test('joins endpoints from an origin-only API base', async () => {
  let requested = ''
  const client = new ApiClient('http://127.0.0.1:3000/', async (input) => {
    requested = String(input)
    return reply({ success: true, data: 'ok', meta })
  })
  assert.equal(await client.request('api/health', {}, z.string()), 'ok')
  assert.equal(requested, 'http://127.0.0.1:3000/api/health')
})

test('rejects an API base with query parameters', () => {
  assert.throws(() => new ApiClient('http://127.0.0.1:3000/api?token=secret-123'),
    (error: unknown) => error instanceof ApiClientError && error.code === 'INVALID_BASE_URL' && !error.message.includes('secret-123'))
})

test('rejects a malformed API base with a safe error', () => {
  assert.throws(() => new ApiClient('http://user:secret-123@['),
    (error: unknown) => error instanceof ApiClientError && error.code === 'INVALID_BASE_URL' && !error.message.includes('secret-123'))
})

test('rejects a malformed success payload instead of returning it', async () => {
  const client = new ApiClient('http://127.0.0.1:3000/api', async () => reply({
    success: true, data: { sessionId: 42 }, meta
  }))
  await assert.rejects(client.request('ftp/sessions', {}, z.object({ sessionId: z.string() })),
    (error: unknown) => error instanceof ApiClientError && error.code === 'INVALID_RESPONSE')
})

test('uses the server error code and message without exposing the submitted password', async () => {
  const client = new ApiClient('http://127.0.0.1:3000/api', async () => reply({
    success: false,
    error: { statusCode: 401, code: 'FTP_AUTH_FAILED', message: 'User alice with password secret-123 was rejected' },
    meta: { ...meta, path: '/api/ftp/sessions/s1/login', requestId: 'r1' }
  }, 401))
  await assert.rejects(client.request('ftp/sessions/s1/login', {
    method: 'POST', body: JSON.stringify({ username: 'alice', password: 'secret-123' })
  }, z.unknown()), (error: unknown) => {
    assert.ok(error instanceof ApiClientError)
    assert.equal(error.code, 'FTP_AUTH_FAILED')
    assert.match(error.message, /rejected/)
    assert.doesNotMatch(error.message, /secret-123/)
    assert.doesNotMatch(error.message, /alice/)
    return true
  })
})

test('turns network, non-JSON, and malformed error responses into safe typed errors', async () => {
  for (const [fetcher, code] of [
    [async () => { throw new Error('connect ECONNREFUSED password=secret-123') }, 'NETWORK_ERROR'],
    [async () => new Response('<html>bad</html>', { status: 502, headers: { 'content-type': 'text/html' } }), 'INVALID_RESPONSE'],
    [async () => reply({ success: false, error: { code: 5 } }, 500), 'INVALID_RESPONSE']
  ] as const) {
    const client = new ApiClient('http://127.0.0.1:3000/api', fetcher)
    await assert.rejects(client.request('ftp/sessions', {}, z.unknown()), (error: unknown) => {
      assert.ok(error instanceof ApiClientError)
      assert.equal(error.code, code)
      assert.doesNotMatch(error.message, /secret-123/)
      return true
    })
  }
})
