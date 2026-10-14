import { transferEventSchema, transferProgressSchema } from '../../schemas/transfer.schema.ts'
import type { DesktopTransferProgress } from '../../shared/desktop-api.ts'
import { ApiClientError } from './api-client.ts'

export type ProgressSocket = Pick<WebSocket, 'addEventListener' | 'removeEventListener' | 'close'>
type Logger = Pick<Console, 'warn'>

export function transferSocketBaseUrl(apiBaseUrl: string, configured?: string): string {
  let url: URL
  try { url = new URL(configured ?? apiBaseUrl) }
  catch { throw new ApiClientError('INVALID_BASE_URL', 'Địa chỉ WebSocket không hợp lệ') }
  const protocols = configured ? ['ws:', 'wss:'] : ['http:', 'https:']
  if (!protocols.includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ApiClientError('INVALID_BASE_URL', 'Địa chỉ WebSocket không hợp lệ')
  }
  if (!configured) {
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    // Nest's gateway is rooted at /transfers, outside the HTTP /api prefix.
    url.pathname = '/'
  }
  return url.toString()
}

export class TransferSocket {
  private readonly baseUrl: string
  private readonly createSocket: (url: string) => ProgressSocket
  private readonly logger: Logger
  private readonly listeners = new Set<(progress: DesktopTransferProgress) => void>()
  private sessionId: string | null = null
  private socket: ProgressSocket | null = null
  private cleanupSocket: (() => void) | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  private retries = 0

  constructor(baseUrl: string, createSocket: (url: string) => ProgressSocket = (url) => new WebSocket(url), logger: Logger = console) {
    this.baseUrl = transferSocketBaseUrl('http://localhost', baseUrl)
    this.createSocket = createSocket
    this.logger = logger
  }

  onProgress(listener: (progress: DesktopTransferProgress) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  connect(sessionId: string): void {
    this.disconnect()
    this.sessionId = sessionId
    this.retries = 0
    this.open()
  }

  disconnect(): void {
    this.sessionId = null
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    this.closeSocket()
  }

  private closeSocket(): void {
    const socket = this.socket
    this.socket = null
    this.cleanupSocket?.()
    this.cleanupSocket = null
    socket?.close()
  }

  private scheduleRetry(): void {
    if (!this.sessionId || this.retry || this.retries >= 5) return
    const delay = 250 * 2 ** this.retries++
    this.retry = setTimeout(() => { this.retry = null; this.open() }, delay)
  }

  private open(): void {
    if (!this.sessionId) return
    const url = new URL('transfers', `${this.baseUrl.replace(/\/+$/, '')}/`)
    url.searchParams.set('sessionId', this.sessionId)
    let socket: ProgressSocket
    try { socket = this.createSocket(url.toString()) }
    catch { this.scheduleRetry(); return }
    this.socket = socket
    const message = (event: Event) => {
      if (this.socket !== socket || !this.sessionId) return
      let parsed
      try {
        const payload: unknown = (event as MessageEvent).data
        if (typeof payload !== 'string') throw new Error('Non-text event')
        parsed = transferEventSchema.safeParse(JSON.parse(payload))
      } catch { this.logger.warn('Ignored malformed FTP transfer event'); return }
      if (!parsed.success) { this.logger.warn('Ignored malformed FTP transfer event'); return }
      if (parsed.data.event === 'transfer.progress') {
        const progress = transferProgressSchema.parse(parsed.data.data)
        for (const listener of this.listeners) listener(progress)
      }
    }
    const close = (event: Event) => {
      if (this.socket !== socket) return
      this.closeSocket()
      if ((event as CloseEvent).code === 1008) this.sessionId = null
      else this.scheduleRetry()
    }
    const error = () => {
      if (this.socket !== socket) return
      this.closeSocket()
      this.scheduleRetry()
    }
    socket.addEventListener('message', message)
    socket.addEventListener('close', close)
    socket.addEventListener('error', error)
    this.cleanupSocket = () => {
      socket.removeEventListener('message', message)
      socket.removeEventListener('close', close)
      socket.removeEventListener('error', error)
    }
  }
}
