import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ApiClient, ApiClientError } from '../src/main/api/api-client.ts'
import { FtpApi } from '../src/main/api/ftp-api.ts'
import { TransferSocket } from '../src/main/api/transfer-socket.ts'
import { deferred } from './deferred.ts'
import { createShutdownHandler } from '../src/main/shutdown.ts'
import { setImmediate as nextTurn } from 'node:timers/promises'

const meta = { timestamp: '2026-10-04T00:00:00.000Z' }
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data, meta }), {
  headers: { 'content-type': 'application/json' }
})
const missing = () => new Response(JSON.stringify({
  success: false,
  error: { statusCode: 404, code: 'FTP_SESSION_NOT_FOUND', message: 'Session missing' },
  meta: { ...meta, path: '/api/ftp/sessions/s1', requestId: 'r1' }
}), { status: 404, headers: { 'content-type': 'application/json' } })

test('connects with parsed FTP host and port and keeps renderer snapshot shape', async () => {
  let body: unknown
  const api = new FtpApi(new ApiClient('http://127.0.0.1:3000/api', async (_input, init) => {
    body = JSON.parse(String(init?.body))
    return ok({ sessionId: 's1', state: 'connected', url: 'ftp://127.0.0.1:2121' })
  }))
  assert.deepEqual(await api.connect('ftp://127.0.0.1:2121'), {
    state: 'connected', url: 'ftp://127.0.0.1:2121', username: null
  })
  assert.deepEqual(body, { host: '127.0.0.1', port: 2121 })
})

test('routes login and file operations with the server request fields', async () => {
  const calls: Array<{ url: string; method: string; body?: unknown }> = []
  const api = new FtpApi(new ApiClient('http://127.0.0.1:3000/api', async (input, init) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ url, method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) })
    if (url.endsWith('/login')) return ok({ sessionId: 's1', state: 'authenticated', url: 'ftp://example.test:21' })
    if (url.includes('/files?') && method === 'GET') return ok([{ name: 'a.txt', type: 'file', size: 3, permissions: '-rw-r--r--' }])
    if (url.endsWith('/pwd')) return ok('/home')
    if (url.endsWith('/cwd') || url.endsWith('/cdup')) return ok('/home')
    if (url.endsWith('/entries')) return ok({ from: 'a.txt', to: 'b.txt' })
    if (url.endsWith('/directories') && method === 'POST') return ok({ name: 'dir' })
    if (method === 'DELETE' && url.includes('/files?')) return ok({ path: 'a.txt' })
    if (method === 'DELETE' && url.includes('/directories?')) return ok({ path: 'dir' })
    if (url.endsWith('/sessions')) return ok({ sessionId: 's1', state: 'connected', url: 'ftp://example.test:21' })
    return ok({ sessionId: 's1', state: 'authenticated', url: 'ftp://example.test:21' })
  }))
  await api.connect('ftp://example.test')
  assert.deepEqual(await api.login({ username: 'alice', password: 'secret-123' }), {
    state: 'authenticated', url: 'ftp://example.test:21', username: 'alice'
  })
  assert.equal(await api.pwd(), '/home')
  assert.deepEqual(await api.list('/a b'), [{ name: 'a.txt', type: 'file', size: 3, permissions: '-rw-r--r--', raw: '' }])
  await api.cwd('/home')
  await api.cdup()
  await api.mkdir('dir')
  await api.deleteFile('a.txt')
  await api.deleteDirectory('dir')
  await api.rename({ from: 'a.txt', to: 'b.txt' })
  assert.deepEqual(calls.map(({ url, method, body }) => [method, url.replace('http://127.0.0.1:3000/api/', ''), body]), [
    ['POST', 'ftp/sessions', { host: 'example.test', port: 21 }],
    ['POST', 'ftp/sessions/s1/login', { username: 'alice', password: 'secret-123' }],
    ['GET', 'ftp/sessions/s1/pwd', undefined],
    ['GET', 'ftp/sessions/s1/files?path=%2Fa+b', undefined],
    ['POST', 'ftp/sessions/s1/cwd', { path: '/home' }],
    ['POST', 'ftp/sessions/s1/cdup', undefined],
    ['POST', 'ftp/sessions/s1/directories', { name: 'dir' }],
    ['DELETE', 'ftp/sessions/s1/files?path=a.txt', undefined],
    ['DELETE', 'ftp/sessions/s1/directories?path=dir&recursive=true', undefined],
    ['PATCH', 'ftp/sessions/s1/entries', { from: 'a.txt', to: 'b.txt' }]
  ])
})

test('clears a missing server session and returns disconnected state afterward', async () => {
  let count = 0
  const api = new FtpApi(new ApiClient('http://127.0.0.1:3000/api', async () => ++count === 1
    ? ok({ sessionId: 's1', state: 'connected', url: 'ftp://example.test:21' })
    : missing()))
  await api.connect('ftp://example.test')
  await assert.rejects(api.state(), (error: unknown) => error instanceof ApiClientError && error.code === 'FTP_SESSION_NOT_FOUND')
  assert.deepEqual(await api.state(), { state: 'disconnected', url: null, username: null })
  assert.equal(count, 2)
})

test('disconnect clears its session even if the server has already lost it', async () => {
  let count = 0
  const api = new FtpApi(new ApiClient('http://127.0.0.1:3000/api', async () => ++count === 1
    ? ok({ sessionId: 's1', state: 'connected', url: 'ftp://example.test:21' })
    : missing()))
  await api.connect('ftp://example.test')
  assert.deepEqual(await api.disconnect(), { state: 'disconnected', url: null, username: null })
  assert.equal(count, 2)
})

test('rejects FTP URLs containing credentials without exposing them', async () => {
  const api = new FtpApi(new ApiClient('http://127.0.0.1:3000/api', async () => { throw new Error('unexpected call') }))
  await assert.rejects(api.connect('ftp://alice:secret-123@example.test'), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.doesNotMatch(error.message, /secret-123/)
    return true
  })
})

test('transfers require a live session before accessing local files', async () => {
  const api = new FtpApi(new ApiClient('http://127.0.0.1:3000/api', async () => { throw new Error('unexpected call') }))
  const input = { transferId: 't1', localPath: 'a', remotePath: 'b' }
  const noSession = (error: unknown) => error instanceof ApiClientError && error.code === 'FTP_SESSION_NOT_FOUND'
  await assert.rejects(api.upload(input), noSession)
  await assert.rejects(api.download(input), noSession)
})

test('wires upload, download and progress while disconnect aborts active local work and closes the socket', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ftp-api-transfer-'))
  t.after(() => rm(directory, { force: true, recursive: true }))
  const localPath = join(directory, 'file.bin')
  await writeFile(localPath, 'upload bytes')
  const socket = new EventTarget() as EventTarget & { close(): void }
  let closed = false
  socket.close = () => { closed = true }
  const progress = new TransferSocket('ws://localhost', () => socket)
  const received: unknown[] = []
  let uploaded = ''
  let downloadSignal: AbortSignal | undefined
  const started = deferred<void>()
  let downloads = 0
  const api = new FtpApi(new ApiClient('http://localhost/api', async (url, init) => {
    if (String(url).endsWith('/uploads')) {
      uploaded = await new Response(init?.body).text()
      return ok({ transferId: 'u1' })
    }
    if (String(url).includes('/downloads?')) {
      if (++downloads === 1) return new Response('download bytes', { headers: { 'content-type': 'application/octet-stream' } })
      downloadSignal = init?.signal ?? undefined
      started.resolve()
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])) } }),
        { headers: { 'content-type': 'application/octet-stream' } })
    }
    if (String(url).includes('/transfers/')) return ok({ transferId: 'd2' })
    return ok({ sessionId: 's1', state: init?.method === 'DELETE' ? 'disconnected' : 'authenticated', url: 'ftp://example.test:21' })
  }), progress)
  api.onTransferProgress((value) => received.push(value))
  await api.connect('ftp://example.test')
  socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ event: 'transfer.progress', data: {
    transferId: 'u1', direction: 'upload', transferredBytes: 4, totalBytes: 12, percentage: 33, bytesPerSecond: 2
  } }) }))
  assert.deepEqual(received, [{ transferId: 'u1', transferredBytes: 4, totalBytes: 12, bytesPerSecond: 2 }])
  await api.upload({ transferId: 'u1', localPath, remotePath: '/file.bin' })
  assert.equal(uploaded, 'upload bytes')
  await api.download({ transferId: 'd1', localPath, remotePath: '/file.bin' })
  assert.equal(await readFile(localPath, 'utf8'), 'download bytes')
  const pending = api.download({ transferId: 'd2', localPath, remotePath: '/file.bin' })
  const rejected = assert.rejects(pending, (error: unknown) => error instanceof ApiClientError && error.code === 'FTP_TRANSFER_CANCELLED')
  await started.promise
  assert.deepEqual(await api.disconnect(), { state: 'disconnected', url: null, username: null })
  await rejected
  assert.equal(downloadSignal?.aborted, true)
  assert.equal(closed, true)
  assert.deepEqual(await readdir(directory), ['file.bin'])
  assert.equal(await readFile(localPath, 'utf8'), 'download bytes')
})

test('disconnect during initial connect retires and deletes the late-created session', async () => {
  const response = deferred<Response>()
  const deleted: string[] = []
  const cleaned = deferred<void>()
  const api = new FtpApi(new ApiClient('http://localhost/api', async (url, init) => {
    if (init?.method === 'POST') return response.promise
    deleted.push(String(url))
    cleaned.resolve()
    return ok({ sessionId: 's1', state: 'disconnected', url: 'ftp://example.test:21' })
  }))
  const connected = api.connect('ftp://example.test')
  const rejected = assert.rejects(connected, (error: unknown) => error instanceof ApiClientError && error.code === 'FTP_SESSION_CANCELLED')
  const disconnected = api.disconnect()
  await disconnected
  await rejected
  response.resolve(ok({ sessionId: 's1', state: 'connected', url: 'ftp://example.test:21' }))
  await cleaned.promise
  assert.deepEqual(deleted, ['http://localhost/api/ftp/sessions/s1'])
  assert.deepEqual(await api.state(), { state: 'disconnected', url: null, username: null })
})

test('disconnect and orderly quit do not wait for a connect POST that ignores abort and never settles', async () => {
  let signal: AbortSignal | null | undefined
  const api = new FtpApi(new ApiClient('http://localhost/api', async (_url, init) => {
    signal = init?.signal
    return new Promise<Response>(() => undefined)
  }))
  const connecting = api.connect('ftp://example.test')
  const rejected = assert.rejects(connecting, (error: unknown) => error instanceof ApiClientError && error.code === 'FTP_SESSION_CANCELLED')
  let quit = false
  const beforeQuit = createShutdownHandler(() => api.disconnect().then(() => undefined), () => { quit = true })
  beforeQuit({ preventDefault() {} })
  await nextTurn()
  assert.equal(quit, true)
  assert.equal(signal?.aborted, true)
  await rejected
  assert.deepEqual(await api.state(), { state: 'disconnected', url: null, username: null })
})

test('connect has a deadline even if the fetch implementation never reacts to abort', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let signal: AbortSignal | null | undefined
  const api = new FtpApi(new ApiClient('http://localhost/api', async (_url, init) => {
    signal = init?.signal
    return new Promise<Response>(() => undefined)
  }))
  let settled = false
  const connecting = api.connect('ftp://example.test').finally(() => { settled = true })
  const rejected = assert.rejects(connecting, (error: unknown) => error instanceof ApiClientError && error.code === 'FTP_CONNECTION_TIMEOUT')
  t.mock.timers.tick(10_000)
  await nextTurn()
  assert.equal(settled, true)
  assert.equal(signal?.aborted, true)
  await rejected
})

test('disconnect bounds a server DELETE that never settles', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.method(console, 'warn', () => undefined)
  const api = new FtpApi(new ApiClient('http://localhost/api', async (_url, init) => {
    if (init?.method === 'DELETE') return new Promise<Response>(() => undefined)
    return ok({ sessionId: 's1', state: 'connected', url: 'ftp://example.test:21' })
  }))
  await api.connect('ftp://example.test')
  let settled = false
  const disconnecting = api.disconnect().then((value) => { settled = true; return value })
  t.mock.timers.tick(10_000)
  await nextTurn()
  assert.equal(settled, true)
  assert.deepEqual(await disconnecting, { state: 'disconnected', url: null, username: null })
})

test('a cancellation transport timeout settles local work and retires the session before queued work is admitted', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ftp-cancel-deadline-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const started = deferred<void>()
  const api = new FtpApi(new ApiClient('http://localhost/api', async (url) => {
    if (String(url).includes('/transfers/')) return new Promise<Response>(() => undefined)
    if (String(url).includes('/downloads?')) {
      started.resolve()
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])) } }),
        { headers: { 'content-type': 'application/octet-stream' } })
    }
    return ok({ sessionId: 's1', state: 'authenticated', url: 'ftp://example.test:21' })
  }))
  await api.connect('ftp://example.test')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const input = { transferId: 't1', localPath: join(directory, 'file.bin'), remotePath: '/first' }
  const isTimeout = (error: unknown) => error instanceof ApiClientError && error.code === 'FTP_TRANSFER_CANCEL_TIMEOUT'
  const transferRejected = assert.rejects(api.download(input), isTimeout)
  await started.promise
  const cancelRejected = assert.rejects(api.cancelTransfer('t1'), isTimeout)
  t.mock.timers.tick(7500)
  await Promise.all([transferRejected, cancelRejected])
  assert.deepEqual(await readdir(directory), [])
  assert.deepEqual(await api.state(), { state: 'disconnected', url: null, username: null })
  await assert.rejects(api.upload({ ...input, transferId: 'next' }),
    (error: unknown) => error instanceof ApiClientError && error.code === 'FTP_SESSION_NOT_FOUND')
})

test('a stale missing-session response cannot clear a newly connected session', async () => {
  const oldState = deferred<Response>()
  let connects = 0
  const api = new FtpApi(new ApiClient('http://localhost/api', async (url, init) => {
    if (init?.method === 'POST') return ok({ sessionId: `s${++connects}`, state: 'connected', url: 'ftp://example.test:21' })
    if (init?.method !== 'DELETE' && String(url).endsWith('/s1')) return oldState.promise
    return ok({ sessionId: 's2', state: init?.method === 'DELETE' ? 'disconnected' : 'connected', url: 'ftp://example.test:21' })
  }))
  await api.connect('ftp://example.test')
  const pending = api.state()
  const rejected = assert.rejects(pending)
  await api.disconnect()
  await api.connect('ftp://example.test')
  oldState.resolve(missing())
  await rejected
  assert.equal((await api.state()).state, 'connected')
})

test('a late cancellation failure cannot retire a newly connected session', async () => {
  const cancellation = deferred<Response>()
  let connects = 0
  const api = new FtpApi(new ApiClient('http://localhost/api', async (url, init) => {
    if (String(url).includes('/transfers/')) return cancellation.promise
    if (init?.method === 'POST') return ok({ sessionId: `s${++connects}`, state: 'connected', url: 'ftp://example.test:21' })
    return ok({ sessionId: 's2', state: init?.method === 'DELETE' ? 'disconnected' : 'connected', url: 'ftp://example.test:21' })
  }))
  await api.connect('ftp://example.test')
  const rejected = assert.rejects(api.cancelTransfer('old-transfer'))
  await api.disconnect()
  await api.connect('ftp://example.test')
  cancellation.resolve(new Response('invalid JSON', { status: 503 }))
  await rejected
  assert.equal((await api.state()).state, 'connected')
})

test('disconnect returns local disconnected state even when the API is offline so the renderer can clear its queue', async (t) => {
  let warning = ''
  t.mock.method(console, 'warn', (message: string) => { warning = message })
  const socket = new EventTarget() as EventTarget & { close(): void }
  let closed = false
  socket.close = () => { closed = true }
  const progress = new TransferSocket('ws://localhost', () => socket)
  const api = new FtpApi(new ApiClient('http://localhost/api', async (_url, init) => {
    if (init?.method === 'DELETE') throw new Error('offline')
    return ok({ sessionId: 's1', state: 'connected', url: 'ftp://example.test:21' })
  }), progress)
  await api.connect('ftp://example.test')
  assert.deepEqual(await api.disconnect(), { state: 'disconnected', url: null, username: null })
  assert.equal(closed, true)
  assert.deepEqual(await api.state(), { state: 'disconnected', url: null, username: null })
  assert.match(warning, /cleanup/i)
})

test('sends drag/drop move and overwrite backup paths unchanged in JSON', async () => {
  const renames: Array<{ from: string; to: string }> = []
  const api = new FtpApi(new ApiClient('http://127.0.0.1:3000/api', async (input, init) => {
    if (init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as { from: string; to: string }
      assert.equal(String(input), 'http://127.0.0.1:3000/api/ftp/sessions/s1/entries')
      renames.push(body)
      return ok(body)
    }
    return ok({ sessionId: 's1', state: 'authenticated', url: 'ftp://example.test:21' })
  }))
  await api.connect('ftp://example.test')
  const destination = '/target folder/my file & notes.txt'
  await api.rename({ from: destination, to: `${destination}.ftp-client-backup-123` })
  await api.rename({ from: '/source folder/my file & notes.txt', to: destination })
  assert.deepEqual(renames, [
    { from: destination, to: `${destination}.ftp-client-backup-123` },
    { from: '/source folder/my file & notes.txt', to: destination }
  ])
})

test('rejects concurrent and repeated connects without creating an unowned server session', async () => {
  let release!: (response: Response) => void
  const pending = new Promise<Response>((resolve) => { release = resolve })
  let creates = 0
  const api = new FtpApi(new ApiClient('http://127.0.0.1:3000/api', async () => {
    creates++
    return creates === 1 ? pending : ok({ sessionId: 's2', state: 'connected', url: 'ftp://other.test:21' })
  }))
  const first = api.connect('ftp://example.test')
  const second = api.connect('ftp://other.test')
  const createsWhilePending = creates
  release(ok({ sessionId: 's1', state: 'connected', url: 'ftp://example.test:21' }))
  await first
  await assert.rejects(second,
    (error: unknown) => error instanceof ApiClientError && error.code === 'FTP_SESSION_CONFLICT')
  assert.equal(createsWhilePending, 1)
  await assert.rejects(api.connect('ftp://other.test'),
    (error: unknown) => error instanceof ApiClientError && error.code === 'FTP_SESSION_CONFLICT')
  assert.equal(creates, 1)
})

test('permits a new connect after the prior attempt fails', async () => {
  let creates = 0
  const api = new FtpApi(new ApiClient('http://127.0.0.1:3000/api', async () => {
    creates++
    return creates === 1 ? Promise.reject(new Error('offline'))
      : ok({ sessionId: 's1', state: 'connected', url: 'ftp://example.test:21' })
  }))
  await assert.rejects(api.connect('ftp://example.test'),
    (error: unknown) => error instanceof ApiClientError && error.code === 'NETWORK_ERROR')
  assert.deepEqual(await api.connect('ftp://example.test'), {
    state: 'connected', url: 'ftp://example.test:21', username: null
  })
  assert.equal(creates, 2)
})
