import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import WebSocket from 'ws'
import { FtpClient } from '../core/ftp-client'
import { FtpSessionService } from '../ftp-session.service'
import { startControlServer } from '../../../test/ftp-test-server'
import { TransferGateway } from './transfer.gateway'

// Only the external WebSocket transport is substituted; the gateway's
// subscription registry and the FTP session lifecycle are real.
class SocketTransport extends EventEmitter {
  readyState = WebSocket.OPEN
  bufferedAmount = 0
  messages: string[] = []
  close() {}
  terminate() {}
  send(message: string, callback: (error?: Error) => void) { this.messages.push(message); callback() }
}

it('does not remove a new subscriber group when a failed old socket emits close after error', async () => {
  const server = await startControlServer()
  const sessions = new FtpSessionService(() => new FtpClient())
  try {
    const { sessionId } = await sessions.create({ host: '127.0.0.1', port: server.port })
    const gateway = new TransferGateway(sessions)
    const request = { url: `/transfers?sessionId=${sessionId}` } as IncomingMessage
    const oldSocket = new SocketTransport()
    const newSocket = new SocketTransport()
    gateway.handleConnection(oldSocket as unknown as WebSocket, request)
    oldSocket.emit('error', new Error('broken socket'))
    gateway.handleConnection(newSocket as unknown as WebSocket, request)
    oldSocket.emit('close')
    gateway.emit(sessionId, { event: 'transfer.completed', data: { transferId: 'new', direction: 'download' } })
    expect(newSocket.messages.map((message) => JSON.parse(message))).toEqual([
      { event: 'transfer.completed', data: { transferId: 'new', direction: 'download' } },
    ])
  } finally { sessions.onModuleDestroy(); await server.close() }
})
