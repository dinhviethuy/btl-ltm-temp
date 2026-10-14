export interface FtpReply {
  code: number
  message: string
  lines: string[]
}

export interface PassiveAddress {
  host: string
  port: number
}

export type RemoteFileType = 'file' | 'directory' | 'link'

export interface RemoteFile {
  name: string
  type: RemoteFileType
  size: number
  permissions: string
  owner?: string
  group?: string
  modified?: string
  raw: string
}
