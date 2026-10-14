import { ArrowDown, ArrowUp, CheckCircle2, CircleEllipsis, LoaderCircle, RefreshCw, X, XCircle } from 'lucide-react'

import type { TransferItem } from '../types/ui-state'

type TransferPanelProps = {
  transfers: TransferItem[]
  onCancel: (transferId: string) => void
  onRetry: (transferId: string) => void
}

const statusLabel = {
  waiting: 'Đang chờ',
  transferring: 'Đang truyền',
  completed: 'Hoàn tất',
  failed: 'Thất bại',
  cancelled: 'Đã hủy'
} as const

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

function formatSpeed(bytesPerSecond: number): string {
  return `${(bytesPerSecond / 1024 ** 2).toFixed(2)} MB/s`
}

export function TransferPanel({ transfers, onCancel, onRetry }: TransferPanelProps): React.JSX.Element {
  return (
    <section className='transfer-panel'>
      <header>
        <div>
          <p className='pane-label'>HÀNG ĐỢI</p>
          <h2>Truyền tệp</h2>
        </div>
        <span className='transfer-count'>{String(transfers.length).padStart(2, '0')}</span>
      </header>
      <div className='transfer-list'>
        {transfers.length === 0 && <div className='transfer-empty'>Kéo tệp giữa hai khung hoặc dùng menu tải tệp</div>}
        {transfers.map((transfer) => {
          const Direction = transfer.direction === 'upload' ? ArrowUp : ArrowDown
          const StatusIcon =
            transfer.status === 'completed'
              ? CheckCircle2
              : transfer.status === 'failed' || transfer.status === 'cancelled'
                ? XCircle
                : transfer.status === 'transferring'
                  ? LoaderCircle
                  : CircleEllipsis
          const percent =
            transfer.totalBytes && transfer.totalBytes > 0
              ? Math.min(100, Math.round((transfer.transferredBytes / transfer.totalBytes) * 100))
              : transfer.status === 'completed'
                ? 100
                : 0

          return (
            <div className='transfer-row' data-status={transfer.status} key={transfer.id}>
              <span className='transfer-direction'>
                <Direction size={16} />
              </span>
              <div className='transfer-info'>
                <div className='transfer-title-line'>
                  <strong>{transfer.name}</strong>
                  <span>{percent}%</span>
                </div>
                <div className='transfer-progress' aria-label={`Tiến độ ${percent}%`}>
                  <span style={{ transform: `scaleX(${percent / 100})` }} />
                </div>
                <span className='transfer-detail'>
                  {transfer.error ?? transfer.detail} · {formatBytes(transfer.transferredBytes)} /{' '}
                  {transfer.totalBytes === null ? '—' : formatBytes(transfer.totalBytes)}
                  {transfer.status === 'transferring' && ` · ${formatSpeed(transfer.bytesPerSecond)}`}
                </span>
              </div>
              <span className='transfer-status'>
                <StatusIcon size={15} />
                {statusLabel[transfer.status]}
              </span>
              <span className='transfer-actions'>
                {(transfer.status === 'waiting' || transfer.status === 'transferring') && (
                  <button type='button' aria-label={`Hủy ${transfer.name}`} onClick={() => onCancel(transfer.id)}>
                    <X size={15} />
                  </button>
                )}
                {(transfer.status === 'failed' || transfer.status === 'cancelled') && (
                  <button type='button' aria-label={`Thử lại ${transfer.name}`} onClick={() => onRetry(transfer.id)}>
                    <RefreshCw size={14} />
                  </button>
                )}
              </span>
            </div>
          )
        })}
      </div>
    </section>
  )
}
