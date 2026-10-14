import type { RemoteFile, RemoteFileType } from './types'

export function parseListLine(line: string): RemoteFile | null {
  /*
   * FileZilla UNIX-style LIST:
   *
   * -rw-rw-rw- 1 ftp ftp 7 Aug 20 01:25 hello.txt
   * drwxrwxrwx 1 ftp ftp 0 Aug 20 01:26 images
   */
  const match = line.match(
    /^(\S+)\s+\d+\s+(\S+)\s+(\S+)\s+(\d+)\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}:\d{2}|\d{4})\s+(.+)$/
  )

  if (!match) {
    return null
  }

  const permissions = match[1]!
  const owner = match[2]!
  const group = match[3]!
  const sizeRaw = match[4]!
  const month = match[5]!
  const day = match[6]!
  const timeOrYear = match[7]!
  const name = match[8]!

  const firstCharacter = permissions.charAt(0)

  let type: RemoteFileType

  if (firstCharacter === 'd') {
    type = 'directory'
  } else if (firstCharacter === 'l') {
    type = 'link'
  } else if (firstCharacter === '-') {
    type = 'file'
  } else {
    return null
  }

  const size = Number(sizeRaw)

  if (!Number.isSafeInteger(size)) {
    return null
  }

  return {
    name,
    type,
    size,
    permissions,
    owner,
    group,
    modified: `${month} ${day} ${timeOrYear}`,
    raw: line
  }
}

export function parseList(raw: string): RemoteFile[] {
  const files: RemoteFile[] = []
  const lines = raw.split(/\r?\n/)
  for (const line of lines) {
    if (!line) {
      continue
    }
    const file = parseListLine(line)
    if (file) {
      files.push(file)
    }
  }

  return files
}
