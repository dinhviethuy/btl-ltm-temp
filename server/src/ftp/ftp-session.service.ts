import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { ApiException } from '../common/http/api-exception'
import { FtpClient, FtpClientState } from './core/ftp-client'

export const FTP_CLIENT_FACTORY = 'FTP_CLIENT_FACTORY'
export const FTP_SESSION_IDLE_TIMEOUT_MS = 'FTP_SESSION_IDLE_TIMEOUT_MS'
export const DEFAULT_FTP_SESSION_IDLE_TIMEOUT_MS = 30 * 60_000
export type FtpClientFactory = () => FtpClient

export interface FtpSession {
  sessionId: string
  url: string
  client: FtpClient
}

export interface FtpSessionSnapshot {
  sessionId: string
  url: string
  state: FtpClientState
}

interface ManagedFtpSession extends FtpSession {
  dataOperationActive?: boolean
  activityLeases?: number
  idleTimer?: NodeJS.Timeout
  unsubscribe?: () => void
}

@Injectable()
export class FtpSessionService implements OnModuleDestroy {
  private readonly sessions = new Map<string, ManagedFtpSession>()
  private readonly pendingClients = new Set<FtpClient>()
  private closing = false

  constructor(
    @Inject(FTP_CLIENT_FACTORY) private readonly clientFactory: FtpClientFactory,
    @Inject(FTP_SESSION_IDLE_TIMEOUT_MS) private readonly inactivityMs = DEFAULT_FTP_SESSION_IDLE_TIMEOUT_MS,
  ) {}

  async create({ host, port }: { host: string; port: number }): Promise<FtpSessionSnapshot> {
    if (this.closing) throw new ApiException(503, 'FTP_CONNECTION_FAILED', 'Dịch vụ FTP đang đóng')
    const hostname = host.trim()
    const url = `ftp://${hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname}:${port}`
    const client = this.clientFactory()
    this.pendingClients.add(client)
    try {
      await client.connect(url)
      if (this.closing) throw new Error('FTP service is closing')
    } catch (error) {
      client.disconnect()
      throw this.operationError(error, 'FTP_CONNECTION_FAILED', 503, 'Không thể kết nối FTP server')
    } finally {
      this.pendingClients.delete(client)
    }

    const session: ManagedFtpSession = { sessionId: randomUUID(), url, client, activityLeases: 0 }
    this.sessions.set(session.sessionId, session)
    session.unsubscribe = client.onDisconnected(() => this.remove(session, false))
    this.touch(session)
    return this.toSnapshot(session)
  }

  get(sessionId: string): FtpSession {
    const session = this.sessions.get(sessionId)
    if (!session || session.client.getState() === 'disconnected') {
      if (session) this.remove(session, false)
      throw new ApiException(404, 'FTP_SESSION_NOT_FOUND', 'Không tìm thấy phiên FTP')
    }
    this.touch(session)
    return session
  }

  snapshot(sessionId: string): FtpSessionSnapshot {
    return this.toSnapshot(this.get(sessionId))
  }

  /** Keep an in-flight operation alive, then restart a full idle period. */
  retain(sessionId: string): () => void {
    const session = this.get(sessionId) as ManagedFtpSession
    session.activityLeases = (session.activityLeases ?? 0) + 1
    if (session.idleTimer) clearTimeout(session.idleTimer)
    session.idleTimer = undefined
    let released = false
    return () => {
      if (released) return
      released = true
      session.activityLeases = (session.activityLeases ?? 1) - 1
      if (this.sessions.get(sessionId) === session) this.touch(session)
    }
  }

  /** LIST, recursive deletion, upload and download share one passive socket. */
  acquireDataOperation(sessionId: string): () => void {
    const session = this.get(sessionId) as ManagedFtpSession
    if (session.dataOperationActive) {
      throw new ApiException(409, 'FTP_SESSION_CONFLICT', 'Phiên FTP đang sử dụng kênh dữ liệu')
    }
    session.dataOperationActive = true
    const releaseActivity = this.retain(sessionId)
    let released = false
    return () => {
      if (released) return
      released = true
      session.dataOperationActive = false
      releaseActivity()
    }
  }

  async login(sessionId: string, credentials: { username: string; password: string }): Promise<FtpSessionSnapshot> {
    const session = this.get(sessionId)
    if (session.client.getState() !== 'connected') {
      throw new ApiException(409, 'FTP_SESSION_CONFLICT', 'Phiên FTP đã đăng nhập')
    }
    try {
      await session.client.login(credentials)
      if (this.sessions.get(sessionId) !== session || session.client.getState() === 'disconnected') {
        throw new Error('FTP control connection đã đóng')
      }
    } catch (error) {
      const disconnected = session.client.getState() === 'disconnected'
      if (disconnected) this.remove(session, false)
      const transportFailure = disconnected || this.isTransportError(error)
      throw this.operationError(
        error,
        transportFailure ? 'FTP_CONNECTION_FAILED' : 'FTP_AUTH_FAILED',
        transportFailure ? 503 : 401,
        transportFailure ? 'Kết nối FTP đã đóng' : 'Đăng nhập FTP thất bại',
      )
    }
    this.touch(session)
    return this.toSnapshot(session)
  }

  disconnect(sessionId: string): FtpSessionSnapshot {
    const session = this.get(sessionId)
    this.remove(session, true)
    return this.toSnapshot(session)
  }

  onModuleDestroy(): void {
    this.closing = true
    for (const client of this.pendingClients) client.disconnect()
    this.pendingClients.clear()
    for (const session of [...this.sessions.values()]) this.remove(session, true)
  }

  private touch(session: ManagedFtpSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer)
    session.idleTimer = undefined
    if (session.activityLeases) return
    session.idleTimer = setTimeout(() => this.remove(session, true), this.inactivityMs)
    session.idleTimer.unref?.()
  }

  private remove(session: ManagedFtpSession, disconnect: boolean): void {
    if (this.sessions.get(session.sessionId) !== session) return
    this.sessions.delete(session.sessionId)
    if (session.idleTimer) clearTimeout(session.idleTimer)
    session.idleTimer = undefined
    session.unsubscribe?.()
    session.unsubscribe = undefined
    if (disconnect) session.client.disconnect()
  }

  private toSnapshot(session: FtpSession): FtpSessionSnapshot {
    return { sessionId: session.sessionId, url: session.url, state: session.client.getState() }
  }

  private operationError(error: unknown, code: string, status: number, message: string): ApiException {
    const timeout = error instanceof Error && (/timeout/i.test(error.message) || ('code' in error && error.code === 'ETIMEDOUT'))
    return timeout
      ? new ApiException(504, 'FTP_TIMEOUT', 'FTP server không phản hồi kịp thời')
      : new ApiException(status, code, message)
  }

  private isTransportError(error: unknown): boolean {
    if (!(error instanceof Error)) return false
    if ('code' in error && typeof error.code === 'string' && /^(?:ECONN|EPIPE|ENOTFOUND|EHOSTUNREACH)/.test(error.code)) return true
    return /socket|control connection|kết nối FTP|chưa kết nối FTP/i.test(error.message)
  }
}
