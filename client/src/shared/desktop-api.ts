import type { LocalFileType } from '../local/types'

export type FtpClientState = 'disconnected' | 'connected' | 'authenticated'

export type RemoteFileType = 'file' | 'directory' | 'link'

export type DesktopLocalFile = {
  name: string
  path: string
  type: LocalFileType
  size: number
  modifiedAt: string
}

export type DesktopRemoteFile = {
  name: string
  type: RemoteFileType
  size: number
  permissions: string
  owner?: string
  group?: string
  modified?: string
  raw: string
}

export type FtpSessionSnapshot = {
  state: FtpClientState
  url: string | null
  username: string | null
}

export type DesktopTransferInput = {
  transferId: string
  localPath: string
  remotePath: string
  totalBytes?: number
}

export type DesktopTransferProgress = {
  transferId: string
  transferredBytes: number
  totalBytes: number | null
  bytesPerSecond: number
}

export type FtpDesktopApi = {
  connect: (url: string) => Promise<FtpSessionSnapshot>
  login: (credentials: { username: string; password: string }) => Promise<FtpSessionSnapshot>
  disconnect: () => Promise<FtpSessionSnapshot>
  state: () => Promise<FtpSessionSnapshot>
  pwd: () => Promise<string>
  list: (path?: string) => Promise<DesktopRemoteFile[]>
  cwd: (path: string) => Promise<void>
  cdup: () => Promise<void>
  upload: (input: DesktopTransferInput) => Promise<void>
  download: (input: DesktopTransferInput) => Promise<void>
  cancelTransfer: (transferId: string) => Promise<void>
  onTransferProgress: (listener: (progress: DesktopTransferProgress) => void) => () => void
  mkdir: (path: string) => Promise<void>
  deleteFile: (path: string) => Promise<void>
  deleteDirectory: (path: string) => Promise<void>
  rename: (input: { from: string; to: string }) => Promise<void>
}

export type LocalDesktopApi = {
  pwd: () => Promise<string>
  list: (path?: string) => Promise<DesktopLocalFile[]>
  cwd: (path: string) => Promise<void>
  resolvePath: (path: string) => Promise<string>
  chooseDirectory: () => Promise<string | null>
  mkdir: (path: string) => Promise<void>
  rename: (input: { from: string; to: string }) => Promise<void>
  move: (input: { from: string; toDirectory: string; overwrite?: boolean; toName?: string }) => Promise<void>
  deleteFile: (path: string) => Promise<void>
  deleteDirectory: (path: string) => Promise<void>
}

export const IPC_CHANNEL = {
  ftp: {
    connect: 'ftp:connect',
    login: 'ftp:login',
    disconnect: 'ftp:disconnect',
    state: 'ftp:state',
    pwd: 'ftp:pwd',
    list: 'ftp:list',
    cwd: 'ftp:cwd',
    cdup: 'ftp:cdup',
    upload: 'ftp:upload',
    download: 'ftp:download',
    cancelTransfer: 'ftp:cancel-transfer',
    transferProgress: 'ftp:transfer-progress',
    mkdir: 'ftp:mkdir',
    deleteFile: 'ftp:delete-file',
    deleteDirectory: 'ftp:delete-directory',
    rename: 'ftp:rename'
  },
  local: {
    pwd: 'local:pwd',
    list: 'local:list',
    cwd: 'local:cwd',
    resolvePath: 'local:resolve-path',
    chooseDirectory: 'local:choose-directory',
    mkdir: 'local:mkdir',
    rename: 'local:rename',
    move: 'local:move',
    deleteFile: 'local:delete-file',
    deleteDirectory: 'local:delete-directory'
  }
} as const
