export type SessionUiState = 'disconnected' | 'connecting' | 'login-required' | 'logging-in' | 'connected'

export type DirectoryUiState = 'idle' | 'loading' | 'ready' | 'empty' | 'error'

export type TransferStatus = 'waiting' | 'transferring' | 'completed' | 'failed' | 'cancelled'

export type TransferRequest = {
  direction: 'upload' | 'download'
  name: string
  detail: string
  localPath: string
  remotePath: string
  totalBytes: number | null
}

export type TransferItem = {
  id: string
  direction: 'upload' | 'download'
  name: string
  detail: string
  localPath: string
  remotePath: string
  status: TransferStatus
  transferredBytes: number
  totalBytes: number | null
  bytesPerSecond: number
  error?: string
}
