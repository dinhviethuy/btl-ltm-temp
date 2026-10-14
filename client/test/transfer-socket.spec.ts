import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { Duplex } from 'node:stream'
import { mock, test } from 'node:test'

import { TransferSocket, transferSocketBaseUrl, type ProgressSocket } from '../src/main/api/transfer-socket.ts'
import { deferred } from './deferred.ts'

class Socket extends EventTarget implements ProgressSocket {
  closed = false
  close(): void { this.closed = true }
  message(data: string): void { this.dispatchEvent(new MessageEvent('message', { data })) }
  disconnect(code = 1006): void { this.dispatchEvent(Object.assign(new Event('close'), { code })) }
}
const progress = { event: 'transfer.progress', data: {
  transferId: 't1', direction: 'upload', transferredBytes: 32, totalBytes: 100, percentage: 32, bytesPerSecond: 16
} }

function fixture(baseUrl = 'ws://localhost:3000') {
  const sockets: Socket[] = []
  const urls: string[] = []
  const warnings: unknown[] = []
  const client = new TransferSocket(baseUrl, (url) => {
    urls.push(url)
    const socket = new Socket()
    sockets.push(socket)
    return socket
  }, { warn: (message) => warnings.push(message) })
  return { client, sockets, urls, warnings }
}

test('derives WS origin from HTTP API base safely and preserves an explicit WebSocket base path', () => {
  assert.equal(transferSocketBaseUrl('http://localhost:3000/api/'), 'ws://localhost:3000/')
  assert.equal(transferSocketBaseUrl('https://example.test/prefix/api'), 'wss://example.test/')
  assert.equal(transferSocketBaseUrl('https://example.test'), 'wss://example.test/')
  assert.equal(transferSocketBaseUrl('https://example.test/api', 'wss://socket.test/gateway/'), 'wss://socket.test/gateway/')
  for (const bad of ['ws://user:secret@example.test', 'ws://example.test/?token=secret', 'ftp://example.test']) {
    assert.throws(() => transferSocketBaseUrl('https://example.test/api', bad))
  }
})

test('validates every message and forwards only renderer-shaped progress once', () => {
  const { client, sockets, urls, warnings } = fixture('wss://example.test/gateway/')
  const received: unknown[] = []
  const unsubscribe = client.onProgress((value) => received.push(value))
  client.connect('s&1')
  assert.deepEqual(urls, ['wss://example.test/gateway/transfers?sessionId=s%261'])
  sockets[0].message(JSON.stringify(progress))
  sockets[0].message('{bad secret payload')
  sockets[0].message(JSON.stringify({ ...progress, data: { ...progress.data, transferredBytes: -1 } }))
  sockets[0].message(JSON.stringify({ event: 'transfer.completed', data: { transferId: 't1' } }))
  sockets[0].message(JSON.stringify({ event: 'transfer.completed', data: {
    transferId: 't1', direction: 'upload', transferredBytes: 100, totalBytes: 100, percentage: 100
  } }))
  assert.deepEqual(received, [{ transferId: 't1', transferredBytes: 32, totalBytes: 100, bytesPerSecond: 16 }])
  assert.equal(warnings.length, 3)
  assert.doesNotMatch(JSON.stringify(warnings), /secret/)
  unsubscribe()
  sockets[0].message(JSON.stringify(progress))
  assert.equal(received.length, 1)
  client.disconnect()
})

test('closes replaced sockets and ignores stale progress and close events', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { client, sockets } = fixture()
    const received: unknown[] = []
    client.onProgress((value) => received.push(value))
    client.connect('s1')
    client.connect('s2')
    assert.equal(sockets[0].closed, true)
    sockets[0].message(JSON.stringify(progress))
    sockets[0].disconnect()
    mock.timers.tick(60_000)
    assert.equal(sockets.length, 2)
    sockets[1].message(JSON.stringify(progress))
    assert.equal(received.length, 1)
    client.disconnect()
    sockets[1].message(JSON.stringify(progress))
    sockets[1].disconnect()
    mock.timers.tick(60_000)
    assert.equal(sockets.length, 2)
    assert.equal(received.length, 1)
  } finally { mock.timers.reset() }
})

test('reconnects with bounded exponential backoff only while the session is live', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { client, sockets } = fixture()
    client.connect('s1')
    for (const delay of [250, 500, 1000, 2000, 4000]) {
      const count = sockets.length
      sockets.at(-1)!.disconnect()
      mock.timers.tick(delay - 1)
      assert.equal(sockets.length, count)
      mock.timers.tick(1)
      assert.equal(sockets.length, count + 1)
    }
    sockets.at(-1)!.disconnect()
    mock.timers.tick(60_000)
    assert.equal(sockets.length, 6)
    client.disconnect()
  } finally { mock.timers.reset() }
})

test('never reconnects a server-rejected or disconnected FTP session', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { client, sockets } = fixture()
    client.connect('s1')
    sockets[0].disconnect(1008)
    mock.timers.tick(60_000)
    assert.equal(sockets.length, 1)
    client.disconnect()
  } finally { mock.timers.reset() }
})

test('receives progress over a real standard WebSocket upgrade without Socket.IO', { timeout: 5000 }, async (t) => {
  const server = createServer()
  const peers: Duplex[] = []
  let requestUrl = ''
  server.on('upgrade', (request, peer) => {
    peers.push(peer)
    requestUrl = request.url ?? ''
    const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    peer.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    const payload = Buffer.from(JSON.stringify(progress))
    const header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(payload.length, 2)
    peer.write(Buffer.concat([header, payload]))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const client = new TransferSocket(`ws://127.0.0.1:${address.port}`)
  t.after(async () => {
    client.disconnect()
    for (const peer of peers) peer.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const received = deferred<unknown>()
  client.onProgress(received.resolve)
  client.connect('live-session')
  assert.deepEqual(await received.promise, { transferId: 't1', transferredBytes: 32, totalBytes: 100, bytesPerSecond: 16 })
  assert.equal(requestUrl, '/transfers?sessionId=live-session')
})
