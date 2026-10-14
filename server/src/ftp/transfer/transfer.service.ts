import { Injectable } from '@nestjs/common'
import { Readable } from 'node:stream'
import { ApiException } from '../../common/http/api-exception'
import { FtpClient, TransferOptions, TransferProgress } from '../core/ftp-client'
import { FtpSessionService } from '../ftp-session.service'
import { TransferGateway } from './transfer.gateway'
import { ActiveTransfer, TransferDirection, TransferInput, UploadInput } from './transfer.types'

@Injectable()
export class TransferService {
  private readonly transfers = new Map<string, ActiveTransfer>()

  constructor(private readonly sessions: FtpSessionService, private readonly events: TransferGateway) {}

  upload(sessionId: string, input: UploadInput, signal?: AbortSignal): Promise<{ transferId: string }> {
    return this.run(sessionId, input, 'upload', async (client, options) => {
      // Own cancellation before FTP setup, not only after STOR attaches its
      // pipeline. Do not destroy on ordinary rejection: HTTP still needs JSON.
      const closeSource = () => { input.stream.destroy() }
      options.signal?.addEventListener('abort', closeSource, { once: true })
      if (options.signal?.aborted) closeSource()
      try { await client.uploadStream(input, options) }
      finally { options.signal?.removeEventListener('abort', closeSource) }
    }, signal)
  }

  download(sessionId: string, input: TransferInput, consume: (stream: Readable) => Promise<void>, signal?: AbortSignal): Promise<{ transferId: string }> {
    return this.run(sessionId, input, 'download', async (client, options, controller) => {
      const download = await client.downloadStream(input, options)
      // RETR can be rejected before a preliminary reply. In that case the
      // consumer must not set binary headers or attach an HTTP pipeline.
      await download.accepted
      const consumer = Promise.resolve().then(() => consume(download.stream as Readable))
      try { await Promise.all([consumer, download.completion]) }
      catch (error) {
        // A broken HTTP consumer must stop FTP too, including a stalled RETR.
        controller.abort()
        if (!(download.stream as Readable).destroyed) (download.stream as Readable).destroy()
        await Promise.allSettled([consumer, download.completion])
        throw error
      }
    }, signal)
  }

  cancel(transferId: string): Promise<{ transferId: string }> {
    const transfer = this.transfers.get(transferId)
    if (!transfer) throw new ApiException(404, 'FTP_TRANSFER_NOT_FOUND', 'Không tìm thấy lượt truyền')
    transfer.cancelRequested = true
    transfer.controller.abort()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // An unresponsive setup command cannot safely share its control stream
        // with another transfer. Retire the session rather than admit work onto
        // a still-owned data lease, and give callers a bounded, explicit result.
        try { this.sessions.disconnect(transfer.sessionId) } catch { /* already closed */ }
        reject(new ApiException(504, 'FTP_TRANSFER_CANCEL_TIMEOUT', 'Quá thời gian hủy lượt truyền; phiên FTP đã đóng'))
      }, 5000)
      void transfer.settled.then(() => { clearTimeout(timer); resolve({ transferId }) })
    })
  }

  private async run(
    sessionId: string, input: TransferInput, direction: TransferDirection,
    operation: (client: FtpClient, options: TransferOptions, controller: AbortController) => Promise<void>, signal?: AbortSignal,
  ): Promise<{ transferId: string }> {
    const client = this.sessions.get(sessionId).client
    if (client.getState() !== 'authenticated' || this.transfers.has(input.transferId)) {
      throw new ApiException(409, 'FTP_SESSION_CONFLICT', 'Phiên FTP chưa sẵn sàng cho lượt truyền')
    }
    const release = this.sessions.acquireDataOperation(sessionId)
    const controller = new AbortController()
    let settled!: () => void
    const transfer: ActiveTransfer = {
      transferId: input.transferId, sessionId, direction, controller, cancelRequested: false,
      settled: new Promise<void>((resolve) => { settled = resolve }),
      startedAt: Date.now(), lastReportedAt: Date.now(), lastReportedBytes: 0, totalBytes: input.totalBytes ?? null,
    }
    this.transfers.set(input.transferId, transfer)
    const abort = () => { transfer.cancelRequested = true; controller.abort() }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    try {
      await operation(client, { signal: controller.signal, totalBytes: input.totalBytes, onProgress: (progress) => this.progress(transfer, progress) }, controller)
      controller.signal.throwIfAborted()
      this.events.emit(sessionId, { event: 'transfer.completed', data: this.summary(transfer) })
      return { transferId: input.transferId }
    } catch {
      const cancelled = transfer.cancelRequested
      const failure = cancelled
        ? new ApiException(409, 'FTP_TRANSFER_CANCELLED', 'Lượt truyền đã bị hủy')
        : new ApiException(502, 'FTP_SERVER_ERROR', 'FTP server từ chối lượt truyền')
      this.events.emit(sessionId, {
        event: cancelled ? 'transfer.cancelled' : 'transfer.failed',
        data: { ...this.summary(transfer), error: { code: failure.code, message: failure.message } },
      })
      throw failure
    } finally {
      signal?.removeEventListener('abort', abort)
      this.transfers.delete(input.transferId)
      release()
      settled()
    }
  }

  private progress(transfer: ActiveTransfer, progress: TransferProgress): void {
    const now = Date.now()
    const bytesPerSecond = Math.max(0, (progress.transferredBytes - transfer.lastReportedBytes) * 1000 / Math.max(1, now - transfer.lastReportedAt))
    transfer.lastReportedAt = now
    transfer.lastReportedBytes = progress.transferredBytes
    transfer.totalBytes = progress.totalBytes
    this.events.emit(transfer.sessionId, { event: 'transfer.progress', data: { ...this.summary(transfer), bytesPerSecond } })
  }

  private summary(transfer: ActiveTransfer) {
    return {
      transferId: transfer.transferId, direction: transfer.direction,
      transferredBytes: transfer.lastReportedBytes, totalBytes: transfer.totalBytes,
      percentage: transfer.totalBytes === null ? null : transfer.totalBytes === 0 ? 100 : Math.min(100, transfer.lastReportedBytes / transfer.totalBytes * 100),
    }
  }
}
