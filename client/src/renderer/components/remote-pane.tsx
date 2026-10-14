import { useCallback, useEffect, useState } from 'react'

import type { DesktopRemoteFile } from '../../shared/desktop-api'
import { useFileConflict } from '../hooks/use-file-conflict'
import type { TransferRequest } from '../types/ui-state'
import { FilePane, type DraggedFile, type FileRow } from './file-pane'
import { TextInputDialog } from './text-input-dialog'

type RemotePaneProps = {
  connected: boolean
  refreshKey: number
  onPathChange: (path: string) => void
  onTransfer: (input: TransferRequest) => void
}

type EditDialogState = { mode: 'create' } | { mode: 'rename'; entry: FileRow } | null

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 ** 2).toFixed(1)} MB`
}

function toFileRow(file: DesktopRemoteFile, directory: string): FileRow {
  const path = directory === '/' ? `/${file.name}` : `${directory.replace(/\/$/, '')}/${file.name}`

  return {
    name: file.name,
    kind: file.type === 'directory' ? 'directory' : 'file',
    size: file.type === 'directory' ? '—' : formatSize(file.size),
    sizeBytes: file.size,
    modified: file.modified ?? '—',
    path
  }
}

export function RemotePane({ connected, refreshKey, onPathChange, onTransfer }: RemotePaneProps): React.JSX.Element {
  const [path, setPath] = useState('/')
  const [files, setFiles] = useState<FileRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editDialog, setEditDialog] = useState<EditDialogState>(null)
  const { resolveConflict, conflictDialog } = useFileConflict()

  const refresh = useCallback(async (): Promise<void> => {
    if (!connected) {
      setFiles([])
      setPath('/')
      onPathChange('/')
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const [currentPath, entries] = await Promise.all([window.ftp.pwd(), window.ftp.list()])
      setPath(currentPath)
      onPathChange(currentPath)
      setFiles(entries.map((entry) => toFileRow(entry, currentPath)))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [connected, refreshKey, onPathChange])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const openDirectory = async (target: string): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      await window.ftp.cwd(target)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setLoading(false)
    }
  }

  const up = async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      await window.ftp.cdup()
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setLoading(false)
    }
  }

  const runManagement = async (operation: () => Promise<void>): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      await operation()
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setLoading(false)
    }
  }

  const createFolder = (): void => {
    setEditDialog({ mode: 'create' })
  }

  const renameEntry = (entry: FileRow): void => {
    setEditDialog({ mode: 'rename', entry })
  }

  const submitEditDialog = (value: string): void => {
    const currentDialog = editDialog
    setEditDialog(null)

    if (!currentDialog) return

    if (currentDialog.mode === 'create') {
      void runManagement(() => window.ftp.mkdir(value))
      return
    }

    if (value !== currentDialog.entry.name) {
      void runManagement(() => window.ftp.rename({ from: currentDialog.entry.name, to: value }))
    }
  }

  const deleteEntry = (entry: FileRow): void => {
    const message =
      entry.kind === 'directory' ? `Xóa thư mục ${entry.name} và toàn bộ nội dung bên trong?` : `Xóa ${entry.name}?`
    if (!window.confirm(message)) return
    void runManagement(() =>
      entry.kind === 'directory' ? window.ftp.deleteDirectory(entry.name) : window.ftp.deleteFile(entry.name)
    )
  }

  const remoteChildPath = (directory: string, name: string): string =>
    directory === '/' ? `/${name}` : `${directory.replace(/\/$/, '')}/${name}`

  const validateFileName = (name: string): void => {
    if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) {
      throw new Error('Tên mới chỉ được chứa tên tệp, không được chứa đường dẫn')
    }
  }

  const resolveRemoteName = async (
    directory: string,
    requestedName: string
  ): Promise<{ name: string; overwrite: boolean } | null> => {
    let name = requestedName

    while (true) {
      validateFileName(name)
      const existing = (await window.ftp.list(directory)).find((entry) => entry.name === name)
      if (!existing) return { name, overwrite: false }
      if (existing.type === 'directory') throw new Error(`Đã tồn tại thư mục cùng tên: ${name}`)

      const resolution = await resolveConflict(name)
      if (resolution.action === 'cancel') return null
      if (resolution.action === 'overwrite') return { name, overwrite: true }
      name = resolution.name
    }
  }

  const resolveLocalName = async (
    directory: string,
    requestedName: string
  ): Promise<{ name: string; overwrite: boolean } | null> => {
    let name = requestedName

    while (true) {
      validateFileName(name)
      const existing = (await window.local.list(directory)).find((entry) => entry.name === name)
      if (!existing) return { name, overwrite: false }
      if (existing.type === 'directory') throw new Error(`Đã tồn tại thư mục cùng tên: ${name}`)

      const resolution = await resolveConflict(name)
      if (resolution.action === 'cancel') return null
      if (resolution.action === 'overwrite') return { name, overwrite: true }
      name = resolution.name
    }
  }

  const queueDownload = async (entry: FileRow): Promise<void> => {
    if (!connected || entry.kind !== 'file') return

    const source = entry.path ?? (path === '/' ? `/${entry.name}` : `${path.replace(/\/$/, '')}/${entry.name}`)

    try {
      const localDirectory = await window.local.pwd()
      const resolution = await resolveLocalName(localDirectory, entry.name)
      if (!resolution) return

      onTransfer({
        direction: 'download',
        name: resolution.name,
        detail: `Máy chủ → Máy cục bộ`,
        localPath: await window.local.resolvePath(resolution.name),
        remotePath: source,
        totalBytes: entry.sizeBytes ?? null
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const queueUpload = async (entry: FileRow, targetDirectory?: FileRow): Promise<void> => {
    if (!connected || !entry.path || entry.kind !== 'file') return

    try {
      const targetPath = targetDirectory?.path ?? path
      const resolution = await resolveRemoteName(targetPath, entry.name)
      if (!resolution) return

      onTransfer({
        direction: 'upload',
        name: resolution.name,
        detail: `Máy cục bộ → ${targetDirectory?.name ?? 'Máy chủ'}`,
        localPath: entry.path,
        remotePath: remoteChildPath(targetPath, resolution.name),
        totalBytes: entry.sizeBytes ?? null
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const handleDrop = (payload: DraggedFile, targetDirectory?: FileRow): void => {
    if (payload.source === 'local') {
      void queueUpload(payload.entry, targetDirectory)
      return
    }

    if (!targetDirectory) return

    void (async () => {
      try {
        const targetPath = targetDirectory.path ?? targetDirectory.name
        const resolution = await resolveRemoteName(targetPath, payload.entry.name)
        if (!resolution) return

        const source = payload.entry.path ?? remoteChildPath(path, payload.entry.name)
        const destination = remoteChildPath(targetPath, resolution.name)
        const backup = resolution.overwrite ? `${destination}.ftp-client-backup-${Date.now()}` : null

        if (backup) await window.ftp.rename({ from: destination, to: backup })

        try {
          await window.ftp.rename({ from: source, to: destination })
        } catch (cause) {
          if (backup) await window.ftp.rename({ from: backup, to: destination }).catch(() => undefined)
          throw cause
        }

        if (backup) await window.ftp.deleteFile(backup)
        await refresh()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
  }

  return (
    <>
      <FilePane
        label='MÁY CHỦ / TỪ XA'
        path={path}
        accent='#4f8173'
        files={files}
        remote
        loading={loading}
        error={connected ? error : 'Kết nối và đăng nhập để duyệt máy chủ'}
        dragSource='remote'
        onDropFile={handleDrop}
        onRefresh={connected ? () => void refresh() : undefined}
        onUp={connected ? () => void up() : undefined}
        onNewFolder={connected ? createFolder : undefined}
        onOpen={(entry) => {
          if (entry.kind === 'directory') void openDirectory(entry.name)
        }}
        actions={(entry) =>
          connected
            ? [
                ...(entry.kind === 'file'
                  ? [
                      {
                        label: 'Tải xuống',
                        onSelect: () => void queueDownload(entry)
                      }
                    ]
                  : [{ label: 'Mở', onSelect: () => void openDirectory(entry.name) }]),
                { label: 'Đổi tên', onSelect: () => renameEntry(entry) },
                { label: 'Xóa', destructive: true, onSelect: () => deleteEntry(entry) }
              ]
            : []
        }
      />
      <TextInputDialog
        open={editDialog !== null}
        title={editDialog?.mode === 'rename' ? 'Đổi tên mục' : 'Tạo thư mục mới'}
        label={editDialog?.mode === 'rename' ? 'Tên mới' : 'Tên thư mục'}
        initialValue={editDialog?.mode === 'rename' ? editDialog.entry.name : ''}
        submitLabel={editDialog?.mode === 'rename' ? 'Đổi tên' : 'Tạo thư mục'}
        onClose={() => setEditDialog(null)}
        onSubmit={submitEditDialog}
      />
      {conflictDialog}
    </>
  )
}
