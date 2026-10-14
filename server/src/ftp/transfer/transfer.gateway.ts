import { OnGatewayConnection, WebSocketGateway } from '@nestjs/websockets'
import type { IncomingMessage } from 'node:http'
import WebSocket from 'ws'
import { FtpSessionService } from '../ftp-session.service'
import type { TransferEvent } from './transfer.types'

@WebSocketGateway({ path: '/transfers', maxPayload: 16 * 1024 })
export class TransferGateway implements OnGatewayConnection {
  private readonly sockets = new Map<string, Set<WebSocket>>()

  constructor(private readonly sessions: FtpSessionService) {}

  handleConnection(socket: WebSocket, request: IncomingMessage): void {
    // Connection callbacks are outside HTTP exception handling; never let an
    // invalid subscription escape into Nest's connection event emitter.
    try {
      const ids = new URL(request.url ?? '', 'http://localhost').searchParams.getAll('sessionId')
      if (ids.length !== 1 || !ids[0]) throw new Error('Invalid sessionId')
      const sessionId = ids[0]
      const session = this.sessions.get(sessionId)
      const subscribers = this.sockets.get(sessionId) ?? new Set<WebSocket>()
      this.sockets.set(sessionId, subscribers)
      subscribers.add(socket)
      const unsubscribe = session.client.onDisconnected(() => socket.close(1008, 'FTP session closed'))
      let cleaned = false
      const cleanup = () => {
        if (cleaned) return
        cleaned = true
        unsubscribe()
        subscribers.delete(socket)
        if (!subscribers.size) this.sockets.delete(sessionId)
      }
      socket.once('close', cleanup)
      socket.once('error', () => { cleanup(); socket.terminate() })
    } catch {
      socket.close(1008, 'Invalid FTP session')
    }
  }

  emit(sessionId: string, event: TransferEvent): void {
    const payload = JSON.stringify(event)
    for (const socket of this.sockets.get(sessionId) ?? []) {
      if (socket.readyState !== WebSocket.OPEN) continue
      // Slow/dead observers must not make FTP backpressure or failure depend on
      // an unbounded WebSocket send queue.
      if (socket.bufferedAmount > 1024 * 1024) { socket.terminate(); continue }
      try { socket.send(payload, (error) => { if (error) socket.terminate() }) }
      catch { socket.terminate() }
    }
  }
}
