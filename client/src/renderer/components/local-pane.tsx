import { useCallback, useEffect, useState } from 'react'

import type { DesktopLocalFile } from '../../shared/desktop-api'
import { useFileConflict } from '../hooks/use-file-conflict'
import type { TransferRequest } from '../types/ui-state'
import { FilePane, type DraggedFile, type FileRow } from './file-pane'
import { TextInputDialog } from './text-input-dialog'

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 ** 2).toFixed(1)} MB`
}

function toFileRow(file: DesktopLocalFile): FileRow {
  return {
    name: file.name,
    kind: file.type === 'directory' ? 'directory' : 'file',
    size: file.type === 'directory' ? '—' : formatSize(file.size),
    sizeBytes: file.size,
    modified: new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', year: '2-digit' }).format(
      new Date(file.modifiedAt)
    ),
    path: file.path
  }
}

type LocalPaneProps = {
  connected: boolean
  remotePath: string
  refreshKey: number
  onTransfer: (input: TransferRequest) => void
}

type EditDialogState = { mode: 'create' } | { mode: 'rename'; entry: FileRow } | null

export function LocalPane({ connected, remotePath, refreshKey, onTransfer }: LocalPaneProps): React.JSX.Element {
  const [path, setPath] = useState('…')
  const [files, setFiles] = useState<FileRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editDialog, setEditDialog] = useState<EditDialogState>(null)
  const { resolveConflict, conflictDialog } = useFileConflict()

  const requireCurrentBridge = (): boolean => {
    const localApi = window.local as Partial<typeof window.local>
    const ready =
      window.desktop.bridgeVersion >= 4 &&
      typeof localApi.mkdir === 'function' &&
      typeof localApi.rename === 'function' &&
      typeof localApi.move === 'function' &&
      typeof localApi.deleteFile === 'function' &&
      typeof localApi.deleteDirectory === 'function'

    if (!ready) {
      setError('Preload đang dùng phiên bản cũ. Hãy đóng hoàn toàn ứng dụng Electron rồi mở lại.')
    }

    return ready
  }

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const [currentPath, entries] = await Promise.all([window.local.pwd(), window.local.list()])
      setPath(currentPath)
      setFiles(entries.map(toFileRow))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh, refreshKey])

  const changeDirectory = async (target: string): Promise<void> => {
    if (!target.trim()) return
    try {
      await window.local.cwd(target)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const chooseDirectory = async (): Promise<void> => {
    try {
      if (typeof window.local.chooseDirectory !== 'function') {
        setError('Preload đang dùng phiên bản cũ. Hãy đóng hoàn toàn ứng dụng Electron rồi mở lại.')
        return
      }

      const selectedPath = await window.local.chooseDirectory()
      if (selectedPath) await changeDirectory(selectedPath)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
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

  const submitEditDialog = (value: string): void => {
    const currentDialog = editDialog
    setEditDialog(null)
    if (!currentDialog || !requireCurrentBridge()) return

    if (currentDialog.mode === 'create') {
      void runManagement(() => window.local.mkdir(value))
    } else if (value !== currentDialog.entry.name) {
      void runManagement(() => window.local.rename({ from: currentDialog.entry.name, to: value }))
    }
  }

  const deleteEntry = (entry: FileRow): void => {
    if (!requireCurrentBridge()) return
    if (!window.confirm(`Xóa ${entry.name}?`)) return
    void runManagement(() =>
      entry.kind === 'directory' ? window.local.deleteDirectory(entry.name) : window.local.deleteFile(entry.name)
    )
  }

  const validateFileName = (name: string): void => {
    if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) {
      throw new Error('Tên mới chỉ được chứa tên tệp, không được chứa đường dẫn')
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

  const queueUpload = async (entry: FileRow): Promise<void> => {
    if (!connected || !entry.path || entry.kind !== 'file') return

    try {
      const resolution = await resolveRemoteName(remotePath, entry.name)
      if (!resolution) return
      const destination =
        remotePath === '/' ? `/${resolution.name}` : `${remotePath.replace(/\/$/, '')}/${resolution.name}`

      onTransfer({
        direction: 'upload',
        name: resolution.name,
        detail: `Máy cục bộ → Máy chủ`,
        localPath: entry.path,
        remotePath: destination,
        totalBytes: entry.sizeBytes ?? null
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const queueDownload = async (entry: FileRow, targetDirectory?: FileRow): Promise<void> => {
    if (!connected || entry.kind !== 'file') return

    try {
      const targetPath = targetDirectory?.path ?? path
      const resolution = await resolveLocalName(targetPath, entry.name)
      if (!resolution) return

      const localPath = await window.local.resolvePath(
        targetDirectory?.path ? `${targetDirectory.path}/${resolution.name}` : resolution.name
      )

      onTransfer({
        direction: 'download',
        name: resolution.name,
        detail: `Máy chủ → ${targetDirectory?.name ?? 'Máy cục bộ'}`,
        localPath,
        remotePath: entry.path ?? entry.name,
        totalBytes: entry.sizeBytes ?? null
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const handleDrop = (payload: DraggedFile, targetDirectory?: FileRow): void => {
    if (payload.source === 'remote') {
      void queueDownload(payload.entry, targetDirectory)
      return
    }

    if (!targetDirectory || !payload.entry.path) return

    void (async () => {
      try {
        const resolution = await resolveLocalName(targetDirectory.path ?? targetDirectory.name, payload.entry.name)
        if (!resolution) return

        await window.local.move({
          from: payload.entry.name,
          toDirectory: targetDirectory.name,
          overwrite: resolution.overwrite,
          toName: resolution.name
        })
        await refresh()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
  }

  return (
    <>
      <FilePane
        label='CỤC BỘ / MÁY NÀY'
        path={path}
        accent='#d05b32'
        files={files}
        loading={loading}
        error={error}
        onRefresh={() => void refresh()}
        onUp={() => void changeDirectory('..')}
        onPathSubmit={(target) => void changeDirectory(target)}
        onChoosePath={() => void chooseDirectory()}
        dragSource='local'
        onDropFile={handleDrop}
        onNewFolder={() => setEditDialog({ mode: 'create' })}
        onOpen={(entry) => {
          if (entry.kind === 'directory') void changeDirectory(entry.name)
        }}
        actions={(entry) => [
          ...(entry.kind === 'file' && entry.path && connected
            ? [
                {
                  label: 'Tải lên',
                  onSelect: () => void queueUpload(entry)
                }
              ]
            : []),
          ...(entry.kind === 'directory' ? [{ label: 'Mở', onSelect: () => void changeDirectory(entry.name) }] : []),
          { label: 'Đổi tên', onSelect: () => setEditDialog({ mode: 'rename', entry }) },
          { label: 'Xóa', destructive: true, onSelect: () => deleteEntry(entry) }
        ]}
      />
      <TextInputDialog
        open={editDialog !== null}
        title={editDialog?.mode === 'rename' ? 'Đổi tên mục cục bộ' : 'Tạo thư mục cục bộ'}
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
