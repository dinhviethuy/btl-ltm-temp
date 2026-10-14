import { z } from 'zod'

import { remoteFileListSchema } from '../../schemas/remote-file.schema.ts'
import { sessionSchema, type ServerSession } from '../../schemas/session.schema.ts'
import type { DesktopRemoteFile, DesktopTransferInput, DesktopTransferProgress, FtpSessionSnapshot } from '../../shared/desktop-api.ts'
import { ApiClient, ApiClientError } from './api-client.ts'
import { TransferClient } from './transfer-client.ts'
import type { TransferSocket } from './transfer-socket.ts'
import { withDeadline } from './request-deadline.ts'

const pathResultSchema = z.object({ path: z.string() })
const nameResultSchema = z.object({ name: z.string() })
const renameResultSchema = z.object({ from: z.string(), to: z.string() })
const disconnected: FtpSessionSnapshot = { state: 'disconnected', url: null, username: null }

function ftpEndpoint(sessionId: string, suffix = ''): string {
  return `ftp/sessions/${encodeURIComponent(sessionId)}${suffix}`
}

function query(path: string, recursive?: boolean): string {
  const params = new URLSearchParams({ path })
  if (recursive !== undefined) params.set('recursive', String(recursive))
  return `?${params}`
}

export class FtpApi {
  private sessionId: string | null = null
  private connecting: Promise<FtpSessionSnapshot> | null = null
  private connectController: AbortController | null = null
  private generation = 0
  private username: string | null = null
  private url: string | null = null

  private readonly client: ApiClient
  private readonly transfers: TransferClient
  private readonly socket?: TransferSocket

  constructor(client: ApiClient, socket?: TransferSocket) {
    this.client = client
    this.transfers = new TransferClient(client)
    this.socket = socket
  }

  async connect(url: string): Promise<FtpSessionSnapshot> {
    if (this.sessionId || this.connecting) {
      throw new ApiClientError('FTP_SESSION_CONFLICT', 'Phiên FTP đã được kết nối hoặc đang kết nối')
    }
    let parsed: URL
    try { parsed = new URL(url) } catch { throw new ApiClientError('INVALID_FTP_URL', 'Địa chỉ FTP không hợp lệ') }
    if (parsed.protocol !== 'ftp:' || !parsed.hostname || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new ApiClientError('INVALID_FTP_URL', 'Địa chỉ FTP không hợp lệ')
    }
    const port = parsed.port ? Number(parsed.port) : 21
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ApiClientError('INVALID_FTP_URL', 'Cổng FTP không hợp lệ')
    const generation = this.generation
    const controller = new AbortController()
    this.connectController = controller
    const connecting = withDeadline(async (signal) => {
      const session = await this.client.request('ftp/sessions', {
        method: 'POST', signal, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ host: parsed.hostname.replace(/^\[|\]$/g, ''), port })
      }, sessionSchema)
      // This observer can outlive the bounded caller when a transport ignores
      // abort. Retire a late ID without ever reopening its socket/session.
      if (generation !== this.generation || signal.aborted) {
        await this.deleteSession(session.sessionId).catch(() => console.warn('Late FTP session cleanup could not be confirmed'))
        throw new ApiClientError('FTP_SESSION_CANCELLED', 'Kết nối FTP đã bị hủy')
      }
      this.sessionId = session.sessionId
      this.username = null
      this.url = session.url
      if (session.state !== 'disconnected') this.socket?.connect(session.sessionId)
      return this.snapshot(session)
    }, 10_000, new ApiClientError('FTP_CONNECTION_TIMEOUT', 'Kết nối FTP quá thời gian chờ'), controller)
    this.connecting = connecting
    try { return await connecting }
    finally {
      if (this.connecting === connecting) this.connecting = null
      if (this.connectController === controller) this.connectController = null
    }
  }

  private async deleteSession(sessionId: string): Promise<void> {
    try {
      await withDeadline((signal) => this.client.request(ftpEndpoint(sessionId), { method: 'DELETE', signal }, sessionSchema),
        10_000, new ApiClientError('FTP_CLEANUP_TIMEOUT', 'Dọn dẹp phiên FTP quá thời gian chờ'))
    }
    catch (error) {
      if (!(error instanceof ApiClientError && error.code === 'FTP_SESSION_NOT_FOUND')) throw error
    }
  }

  async login(credentials: { username: string; password: string }): Promise<FtpSessionSnapshot> {
    const session = await this.call('/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(credentials)
    }, sessionSchema)
    this.username = credentials.username
    return this.snapshot(session)
  }

  async disconnect(): Promise<FtpSessionSnapshot> {
    const sessionId = this.sessionId
    const connecting = this.connecting
    const stopped = this.clear()
    // Local teardown is authoritative even if the server is already offline.
    // Always wait for partial-file cleanup before allowing the renderer to reset.
    const results = await Promise.allSettled([stopped, connecting, sessionId ? this.deleteSession(sessionId) : undefined])
    if (results[2].status === 'rejected') console.warn('FTP server session cleanup could not be confirmed')
    return disconnected
  }

  async state(): Promise<FtpSessionSnapshot> {
    if (!this.sessionId) return disconnected
    return this.snapshot(await this.call('', {}, sessionSchema))
  }

  pwd(): Promise<string> { return this.call('/pwd', {}, z.string()) }

  async list(path?: string): Promise<DesktopRemoteFile[]> {
    const files = await this.call(`/files${path === undefined ? '' : query(path)}`, {}, remoteFileListSchema)
    return files.map((file) => ({ ...file, raw: '' }))
  }

  async cwd(path: string): Promise<void> {
    await this.call('/cwd', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) }, z.string())
  }

  async cdup(): Promise<void> { await this.call('/cdup', { method: 'POST' }, z.string()) }

  async mkdir(name: string): Promise<void> {
    await this.call('/directories', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) }, nameResultSchema)
  }

  async deleteFile(path: string): Promise<void> { await this.call(`/files${query(path)}`, { method: 'DELETE' }, pathResultSchema) }

  async deleteDirectory(path: string): Promise<void> {
    await this.call(`/directories${query(path, true)}`, { method: 'DELETE' }, pathResultSchema)
  }

  async rename(input: { from: string; to: string }): Promise<void> {
    await this.call('/entries', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }, renameResultSchema)
  }

  upload(input: DesktopTransferInput): Promise<void> { return this.withSession((id) => this.transfers.upload(id, input)) }
  download(input: DesktopTransferInput): Promise<void> { return this.withSession((id) => this.transfers.download(id, input)) }
  async cancelTransfer(transferId: string): Promise<void> {
    const generation = this.generation
    try { await this.transfers.cancel(transferId) }
    catch (error) {
      if (this.generation === generation && error instanceof ApiClientError &&
        ['FTP_TRANSFER_CANCEL_TIMEOUT', 'FTP_TRANSFER_SETTLEMENT_FAILED'].includes(error.code)) await this.clear()
      throw error
    }
  }

  onTransferProgress(listener: (progress: DesktopTransferProgress) => void): () => void {
    return this.socket?.onProgress(listener) ?? (() => undefined)
  }

  private async call<T>(suffix: string, init: RequestInit, schema: z.ZodType<T>): Promise<T> {
    return this.withSession((id) => this.client.request(ftpEndpoint(id, suffix), init, schema))
  }

  private async withSession<T>(operation: (sessionId: string) => Promise<T>): Promise<T> {
    if (!this.sessionId) throw new ApiClientError('FTP_SESSION_NOT_FOUND', 'Chưa kết nối FTP')
    const sessionId = this.sessionId
    const generation = this.generation
    try {
      const result = await operation(sessionId)
      if (this.generation !== generation) throw new ApiClientError('FTP_SESSION_CANCELLED', 'Phiên FTP đã kết thúc')
      return result
    }
    catch (error) {
      if (this.generation === generation && error instanceof ApiClientError &&
        ['FTP_SESSION_NOT_FOUND', 'FTP_TRANSFER_CANCEL_TIMEOUT', 'FTP_TRANSFER_SETTLEMENT_FAILED'].includes(error.code)) await this.clear()
      throw error
    }
  }

  private snapshot(session: ServerSession): FtpSessionSnapshot {
    if (session.state === 'disconnected') { void this.clear(); return disconnected }
    this.url = session.url
    return { state: session.state, url: this.url,
      username: session.state === 'authenticated' ? this.username : null }
  }

  private clear(): Promise<void> {
    this.generation++
    this.connectController?.abort(new ApiClientError('FTP_SESSION_CANCELLED', 'Kết nối FTP đã bị hủy'))
    this.sessionId = null
    this.username = null
    this.url = null
    this.socket?.disconnect()
    return this.transfers.abortAll()
  }
}
