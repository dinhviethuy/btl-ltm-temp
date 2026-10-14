import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'

import { ApiClient, ApiClientError } from '../src/main/api/api-client.ts'
import { TransferClient } from '../src/main/api/transfer-client.ts'
import { deferred } from './deferred.ts'

const meta = { timestamp: '2026-10-04T00:00:00.000Z' }
function reply(response: ServerResponse, data: unknown): void {
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify({ success: true, data, meta }))
}
function missing(response: ServerResponse): void {
  response.writeHead(404, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ success: false, error: {
    code: 'FTP_TRANSFER_NOT_FOUND', message: 'Transfer missing', statusCode: 404
  }, meta: { ...meta, path: '/api/ftp/transfers/t1', requestId: 'r1' } }))
}
async function fixture(t: TestContext, handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const directory = await mkdtemp(join(tmpdir(), 'ftp-transfer-client-'))
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await rm(directory, { recursive: true, force: true })
  })
  const transfers = new TransferClient(new ApiClient(`http://127.0.0.1:${address.port}/prefix/api/`))
  return { directory, transfers, localPath: join(directory, 'file.bin') }
}

async function waitForPartial(directory: string): Promise<void> {
  const deadline = Date.now() + 3000
  do {
    for (const name of await readdir(directory)) {
      if (name.includes('.ftp-client-part-') && (await stat(join(directory, name))).size > 0) return
    }
    await nextTurn()
  } while (Date.now() < deadline)
  assert.fail('download never wrote a partial file')
}

test('streams a local upload through HTTP with exact bytes, headers and a prefixed API path', async (t) => {
  const bytes = Buffer.alloc(1024 * 1024 + 17, 137)
  let received: Buffer | undefined
  let headers: IncomingMessage['headers'] | undefined
  let route: string | undefined
  const { localPath, transfers } = await fixture(t, (request, response) => {
    route = `${request.method} ${request.url}`
    headers = request.headers
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => { received = Buffer.concat(chunks); reply(response, { transferId: 't1' }) })
  })
  await writeFile(localPath, bytes)
  await transfers.upload('s1', { transferId: 't1', localPath, remotePath: '/a b&c.bin', totalBytes: 1 })
  assert.equal(route, 'POST /prefix/api/ftp/sessions/s1/uploads')
  assert.equal(headers?.['content-type'], 'application/octet-stream')
  assert.equal(headers?.['x-transfer-id'], 't1')
  assert.equal(headers?.['x-remote-path-encoded'], '%2Fa%20b%26c.bin')
  assert.equal(headers?.['x-remote-path'], undefined)
  assert.equal(headers?.['content-length'], String(bytes.length))
  assert.deepEqual(received, bytes)
})

test('encodes upload paths as ASCII without losing Unicode, boundary spaces or literal percent sequences', async (t) => {
  const paths: unknown[] = []
  const { localPath, transfers } = await fixture(t, (request, response) => {
    paths.push(request.headers['x-remote-path-encoded'])
    request.resume()
    request.on('end', () => reply(response, { transferId: 't1' }))
  })
  await writeFile(localPath, 'bytes')
  for (const remotePath of ['/tệp.txt', ' /report ', '/literal%20%2F.txt']) {
    await transfers.upload('s1', { transferId: 't1', localPath, remotePath })
  }
  assert.deepEqual(paths, ['%2Ft%E1%BB%87p.txt', '%20%2Freport%20', '%2Fliteral%2520%252F.txt'])
})

test('preserves the destination until all response bytes and final HTTP settlement, then atomically replaces it', async (t) => {
  let finish!: () => void
  const started = deferred<void>()
  let route: string | undefined
  const { directory, localPath, transfers } = await fixture(t, (request, response) => {
    route = request.url
    response.writeHead(200, { 'content-type': 'application/octet-stream' })
    response.write('new data')
    finish = () => response.end(' final')
    started.resolve()
  })
  await writeFile(localPath, 'original')
  let completed = false
  const pending = transfers.download('s/1', { transferId: 't1', localPath, remotePath: '/a b&c.bin' }).then(() => { completed = true })
  await started.promise
  await waitForPartial(directory)
  assert.equal(await readFile(localPath, 'utf8'), 'original')
  assert.equal(completed, false)
  finish()
  await pending
  assert.equal(route, '/prefix/api/ftp/sessions/s%2F1/downloads?transferId=t1&remotePath=%2Fa+b%26c.bin')
  assert.equal(await readFile(localPath, 'utf8'), 'new data final')
  assert.deepEqual(await readdir(directory), ['file.bin'])
})

for (const existing of [false, true]) test(`removes failed download partials without touching ${existing ? 'an existing' : 'a missing'} destination`, async (t) => {
  let fail!: () => void
  const { directory, localPath, transfers } = await fixture(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/octet-stream' })
    response.write('partial')
    fail = () => response.destroy(new Error('late FTP failure'))
  })
  if (existing) await writeFile(localPath, 'original')
  const rejected = assert.rejects(transfers.download('s1', { transferId: 't1', localPath, remotePath: '/a.bin' }))
  await waitForPartial(directory)
  fail()
  await rejected
  assert.deepEqual(await readdir(directory), existing ? ['file.bin'] : [])
  if (existing) assert.equal(await readFile(localPath, 'utf8'), 'original')
})

test('cancellation aborts a live response, deletes server transfer idempotently and cleans the partial before settling', async (t) => {
  const started = deferred<void>()
  let deletes = 0
  const { directory, localPath, transfers } = await fixture(t, (request, response) => {
    if (request.method === 'DELETE') { deletes++; missing(response); return }
    response.writeHead(200, { 'content-type': 'application/octet-stream' })
    response.write('partial')
    started.resolve()
  })
  await writeFile(localPath, 'original')
  const pending = transfers.download('s1', { transferId: 't1', localPath, remotePath: '/a.bin' })
  const rejection = assert.rejects(pending, (error: unknown) => error instanceof ApiClientError && error.code === 'FTP_TRANSFER_CANCELLED')
  await started.promise
  await waitForPartial(directory)
  await Promise.all([transfers.cancel('t1'), transfers.cancel('t1')])
  await rejection
  assert.equal(deletes, 1)
  assert.equal(await readFile(localPath, 'utf8'), 'original')
  assert.deepEqual(await readdir(directory), ['file.bin'])
  await transfers.cancel('t1')
  assert.equal(deletes, 2)
})

test('the active transfer promise waits for the server cancellation settlement barrier', async (t) => {
  const cancelling = deferred<void>()
  let finishCancel!: () => void
  const { directory, localPath, transfers } = await fixture(t, (request, response) => {
    if (request.method === 'DELETE') {
      finishCancel = () => reply(response, { transferId: 't1' })
      cancelling.resolve()
      return
    }
    response.writeHead(200, { 'content-type': 'application/octet-stream' })
    response.write('partial')
  })
  let settled = false
  const transfer = transfers.download('s1', { transferId: 't1', localPath, remotePath: '/first' })
    .finally(() => { settled = true })
  const rejected = assert.rejects(transfer, (error: unknown) => error instanceof ApiClientError && error.code === 'FTP_TRANSFER_CANCELLED')
  await waitForPartial(directory)
  const cancellation = transfers.cancel('t1')
  await cancelling.promise
  try {
    const deadline = Date.now() + 3000
    while ((await readdir(directory)).length > 0 && Date.now() < deadline) await nextTurn()
    await nextTurn()
    assert.deepEqual(await readdir(directory), [])
    assert.equal(settled, false)
  } finally {
    finishCancel()
    await cancellation
    await rejected
  }
})

test('validates upload JSON before resolving and rejects mismatched transfer IDs', async (t) => {
  const { localPath, transfers } = await fixture(t, (request, response) => {
    request.resume()
    request.on('end', () => reply(response, { transferId: 'different-id' }))
  })
  await writeFile(localPath, 'bytes')
  await assert.rejects(transfers.upload('s1', { transferId: 't1', localPath, remotePath: '/a.bin' }),
    (error: unknown) => error instanceof ApiClientError && error.code === 'INVALID_RESPONSE')
})

test('rejects JSON download responses instead of publishing them as a file', async (t) => {
  const { directory, localPath, transfers } = await fixture(t, (_request, response) => reply(response, { unexpected: true }))
  await assert.rejects(transfers.download('s1', { transferId: 't1', localPath, remotePath: '/a.bin' }),
    (error: unknown) => error instanceof ApiClientError && error.code === 'INVALID_RESPONSE')
  assert.deepEqual(await readdir(directory), [])
})

test('rejects invalid transfer IDs before touching local files or sending requests', async () => {
  let calls = 0
  const transfers = new TransferClient(new ApiClient('http://127.0.0.1/api', async () => { calls++; throw new Error('unexpected') }))
  await assert.rejects(transfers.download('s1', { transferId: '../bad', localPath: 'missing', remotePath: '/a.bin' }))
  assert.equal(calls, 0)
})

test('cancels a streamed upload before the server acknowledges it and aborts the local HTTP request', { timeout: 5000 }, async (t) => {
  const started = deferred<void>()
  const aborted = deferred<void>()
  let deleted = ''
  let resume!: () => void
  const { localPath, transfers } = await fixture(t, (request, response) => {
    if (request.method === 'DELETE') { deleted = request.url ?? ''; reply(response, { transferId: 't1' }); return }
    response.on('close', () => aborted.resolve())
    request.once('data', () => { request.pause(); resume = () => { request.resume() }; started.resolve() })
  })
  await writeFile(localPath, Buffer.alloc(8 * 1024 * 1024, 17))
  const rejected = assert.rejects(transfers.upload('s1', { transferId: 't1', localPath, remotePath: '/file.bin' }),
    (error: unknown) => error instanceof ApiClientError && error.code === 'FTP_TRANSFER_CANCELLED')
  await started.promise
  const cancelled = transfers.cancel('t1')
  // Drain any bytes already buffered by HTTP so the fixture can observe EOF.
  resume()
  await cancelled
  await rejected
  await aborted.promise
  assert.equal(deleted, '/prefix/api/ftp/transfers/t1')
  assert.equal((await stat(localPath)).size, 8 * 1024 * 1024)
})

test('removes its own temporary file if atomic destination replacement fails', async (t) => {
  const { directory, localPath, transfers } = await fixture(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/octet-stream' })
    response.end('file bytes')
  })
  await mkdir(localPath)
  await writeFile(join(localPath, 'keep.txt'), 'existing child')
  await assert.rejects(transfers.download('s1', { transferId: 't1', localPath, remotePath: '/file.bin' }))
  assert.equal(await readFile(join(localPath, 'keep.txt'), 'utf8'), 'existing child')
  assert.deepEqual(await readdir(directory), ['file.bin'])
})

test('sends an empty file as a zero-length streamed upload', async (t) => {
  let length: string | undefined
  const { localPath, transfers } = await fixture(t, (request, response) => {
    length = request.headers['content-length']
    request.resume()
    request.on('end', () => reply(response, { transferId: 't1' }))
  })
  await writeFile(localPath, '')
  await transfers.upload('s1', { transferId: 't1', localPath, remotePath: '/empty.bin' })
  assert.equal(length, '0')
})

test('validates download error envelopes and never replaces an existing file with an API error', async (t) => {
  const { directory, localPath, transfers } = await fixture(t, (_request, response) => {
    response.writeHead(502, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ success: false, error: { statusCode: 502, code: 'FTP_SERVER_ERROR', message: 'RETR rejected' },
      meta: { ...meta, requestId: 'r1', path: '/api/ftp/sessions/s1/downloads' } }))
  })
  await writeFile(localPath, 'original')
  await assert.rejects(transfers.download('s1', { transferId: 't1', localPath, remotePath: '/file.bin' }),
    (error: unknown) => error instanceof ApiClientError && error.code === 'FTP_SERVER_ERROR')
  assert.equal(await readFile(localPath, 'utf8'), 'original')
  assert.deepEqual(await readdir(directory), ['file.bin'])
})
