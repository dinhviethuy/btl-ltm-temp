import path from 'node:path'

import { lstat, mkdir, readdir, rename, rmdir, stat, unlink } from 'node:fs/promises'

import type { LocalFile, LocalFileType } from './types'

export class LocalFileSystem {
  private currentDirectory: string

  constructor(initialDirectory = process.cwd()) {
    this.currentDirectory = path.resolve(initialDirectory)
  }

  lpwd(): string {
    return this.currentDirectory
  }

  async lcd(target: string): Promise<void> {
    if (!target.trim()) {
      throw new Error('Local path không được để trống')
    }
    const resolved = path.resolve(this.currentDirectory, target)
    let info
    try {
      info = await stat(resolved)
    } catch {
      throw new Error(`Local path không tồn tại: ${resolved}`)
    }
    if (!info.isDirectory()) {
      throw new Error(`Local path không phải thư mục: ${resolved}`)
    }
    this.currentDirectory = resolved
  }

  async lls(target?: string): Promise<LocalFile[]> {
    const directory = target?.trim() ? path.resolve(this.currentDirectory, target) : this.currentDirectory
    const directoryStat = await stat(directory)
    if (!directoryStat.isDirectory()) {
      throw new Error(`Local path không phải thư mục: ${directory}`)
    }
    const entries = await readdir(directory, {
      withFileTypes: true
    })
    const files: LocalFile[] = []
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name)
      const info = await lstat(fullPath)
      let type: LocalFileType
      if (entry.isDirectory()) {
        type = 'directory'
      } else if (entry.isSymbolicLink()) {
        type = 'link'
      } else {
        type = 'file'
      }
      files.push({
        name: entry.name,
        path: fullPath,
        type,
        size: info.size,
        modifiedAt: info.mtime
      })
    }
    return files
  }

  resolvePath(target: string): string {
    if (!target.trim()) throw new Error('Tên file không được để trống')
    // A drive-relative name consults that drive's working directory on Windows.
    if (/^[a-z]:($|[^\\/])/i.test(target)) throw new Error('Tên file không hợp lệ')
    const resolved = path.resolve(this.currentDirectory, target)
    const relative = path.relative(this.currentDirectory, resolved)
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('Đường dẫn đích nằm ngoài thư mục đã chọn')
    }
    // Validate the original components before normalization can hide an alias.
    const root = path.parse(target).root
    for (const name of target.slice(root.length).split(/[\\/]/)) this.validateEntryName(name, 'Tên file')
    return resolved
  }

  async mkdir(target: string): Promise<void> {
    await mkdir(this.resolveEntryName(target, 'Tên thư mục'))
  }

  async rename(from: string, to: string): Promise<void> {
    await rename(this.resolveEntryName(from, 'Tên hiện tại'), this.resolveEntryName(to, 'Tên mới'))
  }

  async move(from: string, toDirectory: string, overwrite = false, toName?: string): Promise<void> {
    const source = this.resolveEntryName(from, 'Tên file')
    const directory = this.resolveEntryName(toDirectory, 'Tên thư mục đích')
    const directoryStat = await stat(directory)

    if (!directoryStat.isDirectory()) throw new Error('Đích di chuyển không phải thư mục')

    const destinationName = toName ? path.basename(this.resolveEntryName(toName, 'Tên mới')) : path.basename(source)
    const destination = this.resolvePath(path.join(directory, destinationName))
    let backup: string | null = null

    try {
      const destinationStat = await lstat(destination)

      if (!overwrite) throw new Error(`Đã tồn tại mục cùng tên: ${destinationName}`)
      if (!destinationStat.isFile()) throw new Error('Không thể ghi đè lên thư mục cùng tên')

      backup = `${destination}.ftp-client-backup-${process.pid}-${Date.now()}`
      await rename(destination, backup)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }

    try {
      await rename(source, destination)
    } catch (error) {
      if (backup) await rename(backup, destination).catch(() => undefined)
      throw error
    }

    if (backup) await unlink(backup)
  }

  async deleteFile(target: string): Promise<void> {
    await unlink(this.resolveEntryName(target, 'Tên file'))
  }

  async deleteDirectory(target: string): Promise<void> {
    await rmdir(this.resolveEntryName(target, 'Tên thư mục'))
  }

  private resolveEntryName(target: string, label: string): string {
    this.validateEntryName(target, label)
    return this.resolvePath(target)
  }

  private validateEntryName(name: string, label: string): void {
    if (!name.trim()) throw new Error(`${label} không được để trống`)
    if (name === '.' || name === '..') {
      throw new Error(`${label} chỉ được chứa tên mục, không được chứa đường dẫn`)
    }
    // Windows forbids drive prefixes, alternate data streams, device names,
    // trailing dots/spaces and control characters. Keep Unicode and inner spaces.
    if (/[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) ||
        /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]|CONIN\$|CONOUT\$)(?: *\.| *$)/i.test(name)) {
      throw new Error(`${label} không hợp lệ`)
    }
  }
}
