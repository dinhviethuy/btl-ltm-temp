import type { Readable } from 'node:stream'

export type TransferDirection = 'upload' | 'download'

export type ActiveTransfer = {
  transferId: string
  sessionId: string
  direction: TransferDirection
  controller: AbortController
  settled: Promise<void>
  cancelRequested: boolean
  startedAt: number
  lastReportedAt: number
  lastReportedBytes: number
  totalBytes: number | null
}

export type TransferEvent = {
  event: 'transfer.progress' | 'transfer.completed' | 'transfer.cancelled' | 'transfer.failed'
  data: {
    transferId: string
    direction: TransferDirection
    transferredBytes?: number
    totalBytes?: number | null
    percentage?: number | null
    bytesPerSecond?: number
    error?: { code: string; message: string }
  }
}

export type TransferInput = { transferId: string; remotePath: string; totalBytes?: number }
export type UploadInput = TransferInput & { stream: Readable }
