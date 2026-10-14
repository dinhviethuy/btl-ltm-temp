export type LocalFileType = 'file' | 'directory' | 'link'

export interface LocalFile {
  name: string
  path: string
  type: LocalFileType
  size: number
  modifiedAt: Date
}
