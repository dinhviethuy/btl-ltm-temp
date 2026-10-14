import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import { ApiClient } from '../src/main/api/api-client.ts'
import { FtpApi } from '../src/main/api/ftp-api.ts'
import { TransferSocket } from '../src/main/api/transfer-socket.ts'
import { registerFtpIpc } from '../src/main/ipc/ftp-api-ipc.ts'
import { IPC_CHANNEL } from '../src/shared/desktop-api.ts'

test('registers every FTP invoke channel and replaces prior handlers on repeat registration', async () => {
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>()
  const ipc = {
    handle(channel: string, callback: Parameters<IpcMain['handle']>[1]) {
      assert.equal(handlers.has(channel), false, `duplicate ${channel}`)
      handlers.set(channel, callback)
    },
    removeHandler(channel: string) { handlers.delete(channel) }
  }
  const api = new FtpApi(new ApiClient('http://127.0.0.1:3000/api', async () => new Response(JSON.stringify({
    success: true, data: { sessionId: 's1', state: 'connected', url: 'ftp://example.test:21' },
    meta: { timestamp: '2026-10-04T00:00:00.000Z' }
  }))))
  const firstDispose = registerFtpIpc(api, ipc)
  assert.deepEqual([...handlers.keys()].sort(), Object.values(IPC_CHANNEL.ftp).filter((name) => name !== IPC_CHANNEL.ftp.transferProgress).sort())
  const connect = handlers.get(IPC_CHANNEL.ftp.connect)
  assert.ok(connect)
  assert.deepEqual(await connect(null as unknown as IpcMainInvokeEvent, 'ftp://example.test'), {
    state: 'connected', url: 'ftp://example.test:21', username: null
  })
  const secondDispose = registerFtpIpc(api, ipc)
  firstDispose()
  assert.equal(handlers.size, Object.values(IPC_CHANNEL.ftp).length - 1)
  secondDispose()
  assert.equal(handlers.size, 0)
})

test('forwards progress once per live window and removes subscriptions on IPC replacement and disposal', async () => {
  const socket = new EventTarget() as EventTarget & { close(): void }
  socket.close = () => undefined
  const progress = new TransferSocket('ws://localhost', () => socket)
  const api = new FtpApi(new ApiClient('http://localhost/api', async () => new Response(JSON.stringify({
    success: true, data: { sessionId: 's1', state: 'connected', url: 'ftp://example.test:21' },
    meta: { timestamp: '2026-10-04T00:00:00.000Z' }
  }))), progress)
  const sent: unknown[] = []
  const windows = () => [
    { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (...args: unknown[]) => sent.push(args) } },
    { isDestroyed: () => true, webContents: { isDestroyed: () => true, send: () => assert.fail('destroyed window') } }
  ]
  const ipc = { handle() {}, removeHandler() {} }
  const first = registerFtpIpc(api, ipc, windows)
  await api.connect('ftp://example.test')
  const second = registerFtpIpc(api, ipc, windows)
  first()
  const send = () => socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ event: 'transfer.progress', data: {
    transferId: 't1', direction: 'download', transferredBytes: 20, totalBytes: null, percentage: null, bytesPerSecond: 10
  } }) }))
  send()
  assert.deepEqual(sent, [[IPC_CHANNEL.ftp.transferProgress, { transferId: 't1', transferredBytes: 20, totalBytes: null, bytesPerSecond: 10 }]])
  second()
  send()
  assert.equal(sent.length, 1)
  progress.disconnect()
})
