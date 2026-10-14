import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, rename, rm, stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { finished, pipeline } from 'node:stream/promises'
import type { ReadableStream } from 'node:stream/web'

import { transferIdSchema, transferInputSchema, transferResultSchema } from '../../schemas/transfer.schema.ts'
import type { DesktopTransferInput } from '../../shared/desktop-api.ts'
import { ApiClient, ApiClientError } from './api-client.ts'
import { withDeadline } from './request-deadline.ts'

type ActiveTransfer = { controller: AbortController; done: Promise<void>; cancellation?: Promise<void> }

export class TransferClient {
  private readonly client: ApiClient
  private readonly active = new Map<string, ActiveTransfer>()

  constructor(client: ApiClient) { this.client = client }

  upload(sessionId: string, input: DesktopTransferInput): Promise<void> {
    return this.run(input, async (signal) => {
      const file = await stat(input.localPath)
      if (!file.isFile()) throw new ApiClientError('INVALID_LOCAL_FILE', 'Đường dẫn tải lên phải là tệp')
      signal.throwIfAborted()
      const source = createReadStream(input.localPath, { signal })
      try {
        const init: RequestInit & { duplex: 'half' } = {
          method: 'POST', signal, duplex: 'half',
          headers: { 'content-type': 'application/octet-stream', 'content-length': String(file.size),
            'x-transfer-id': input.transferId, 'x-remote-path-encoded': encodeURIComponent(input.remotePath) },
          // Count queued bytes, not chunks, to preserve filesystem backpressure.
          body: Readable.toWeb(source, { strategy: {
            highWaterMark: source.readableHighWaterMark,
            size: (chunk: Buffer) => chunk.byteLength
          } }) as globalThis.ReadableStream<Uint8Array>
        }
        await this.client.request(`ftp/sessions/${encodeURIComponent(sessionId)}/uploads`, init, this.resultSchema(input.transferId))
      } finally {
        source.destroy()
        await finished(source).catch(() => undefined)
      }
    })
  }

  download(sessionId: string, input: DesktopTransferInput): Promise<void> {
    return this.run(input, async (signal) => {
      const params = new URLSearchParams({ transferId: input.transferId, remotePath: input.remotePath })
      const response = await this.client.requestResponse(`ftp/sessions/${encodeURIComponent(sessionId)}/downloads?${params}`, { signal })
      if (!response.ok || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/octet-stream') {
        await this.client.parseResponse(response, this.resultSchema(input.transferId))
        throw new ApiClientError('INVALID_RESPONSE', 'API server không trả về luồng tệp')
      }
      if (!response.body) throw new ApiClientError('INVALID_RESPONSE', 'API server không trả về luồng tệp')

      // A unique sibling keeps an existing destination intact on any failure.
      // The server ends HTTP only after the FTP completion reply has succeeded.
      const partial = `${input.localPath}.ftp-client-part-${input.transferId}-${randomUUID()}`
      let file: Awaited<ReturnType<typeof open>> | undefined
      let published = false
      try {
        file = await open(partial, 'wx')
        await pipeline(Readable.fromWeb(response.body as ReadableStream<Uint8Array>), file.createWriteStream(), { signal })
        signal.throwIfAborted()
        await rename(partial, input.localPath)
        published = true
      } finally {
        await response.body.cancel().catch(() => undefined)
        await file?.close()
        if (file && !published) await rm(partial, { force: true })
      }
    })
  }

  async cancel(transferId: string): Promise<void> {
    transferIdSchema.parse(transferId)
    const active = this.active.get(transferId)
    if (!active) return this.requestCancellation(transferId)
    active.cancellation ??= this.requestCancellation(transferId)
    active.controller.abort()
    // The operation itself also waits for this remote barrier; do not make the
    // remote request depend on local `done`, which would create a wait cycle.
    const [remote] = await Promise.allSettled([active.cancellation, active.done])
    if (remote.status === 'rejected') throw remote.reason
  }

  private async requestCancellation(transferId: string): Promise<void> {
    try {
      await withDeadline((signal) => this.client.request(`ftp/transfers/${encodeURIComponent(transferId)}`, {
        method: 'DELETE', signal
      }, this.resultSchema(transferId)), 7500,
      new ApiClientError('FTP_TRANSFER_CANCEL_TIMEOUT', 'Không xác nhận được việc hủy lượt truyền trong thời gian cho phép'))
    } catch (error) {
      if (error instanceof ApiClientError && error.code === 'FTP_TRANSFER_NOT_FOUND') return
      if (error instanceof ApiClientError && error.code === 'FTP_TRANSFER_CANCEL_TIMEOUT') throw error
      throw new ApiClientError('FTP_TRANSFER_SETTLEMENT_FAILED', 'Không xác nhận được việc dừng lượt truyền; cần kết nối lại FTP')
    }
  }

  async abortAll(): Promise<void> {
    await Promise.allSettled([...this.active.keys()].map((id) => this.cancel(id)))
  }

  private resultSchema(transferId: string) {
    return transferResultSchema.refine((result) => result.transferId === transferId)
  }

  private async run(input: DesktopTransferInput, operation: (signal: AbortSignal) => Promise<void>): Promise<void> {
    transferInputSchema.parse(input)
    if (this.active.has(input.transferId)) throw new ApiClientError('FTP_SESSION_CONFLICT', 'Lượt truyền đang hoạt động')
    const controller = new AbortController()
    let complete!: () => void
    const done = new Promise<void>((resolve) => { complete = resolve })
    const active: ActiveTransfer = { controller, done }
    this.active.set(input.transferId, active)
    try { await operation(controller.signal) }
    catch (error) {
      if (controller.signal.aborted) throw new ApiClientError('FTP_TRANSFER_CANCELLED', 'Lượt truyền đã bị hủy')
      throw error
    } finally {
      try {
        if (controller.signal.aborted) await active.cancellation
      } finally {
        this.active.delete(input.transferId)
        complete()
      }
    }
  }
}
