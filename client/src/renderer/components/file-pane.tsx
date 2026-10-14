import { File, Folder, FolderUp, MoreHorizontal, Plus, RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import type { DirectoryUiState } from '../types/ui-state'

export type FileRow = {
  name: string
  kind: 'file' | 'directory'
  size: string
  sizeBytes?: number
  modified: string
  path?: string
}
export type FileAction = { label: string; onSelect: () => void; destructive?: boolean }
export type DraggedFile = { source: 'local' | 'remote'; entry: FileRow }

function readDraggedFile(dataTransfer: DataTransfer): DraggedFile | null {
  try {
    const payload = JSON.parse(dataTransfer.getData('application/x-ftp-file')) as DraggedFile
    return payload.entry.kind === 'file' ? payload : null
  } catch {
    return null
  }
}

type FilePaneProps = {
  label: string
  path: string
  accent: string
  files: FileRow[]
  remote?: boolean
  loading?: boolean
  error?: string | null
  onOpen?: (entry: FileRow) => void
  onUp?: () => void
  onRefresh?: () => void
  actions?: (entry: FileRow) => FileAction[]
  onNewFolder?: () => void
  onPathSubmit?: (path: string) => void
  onChoosePath?: () => void
  dragSource?: 'local' | 'remote'
  onDropFile?: (payload: DraggedFile, targetDirectory?: FileRow) => void
}

export function FilePane({
  label,
  path,
  accent,
  files,
  remote = false,
  loading = false,
  error,
  onOpen,
  onUp,
  onRefresh,
  actions,
  onNewFolder,
  onPathSubmit,
  onChoosePath,
  dragSource,
  onDropFile
}: FilePaneProps): React.JSX.Element {
  const [menuEntry, setMenuEntry] = useState<string | null>(null)
  const [pathInput, setPathInput] = useState(path)
  const [dragOver, setDragOver] = useState(false)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const paneRef = useRef<HTMLElement>(null)
  const directoryState: DirectoryUiState = loading
    ? 'loading'
    : error
      ? 'error'
      : files.length === 0
        ? 'empty'
        : 'ready'

  useEffect(() => {
    setPathInput(path)
    setMenuEntry(null)
  }, [path])

  useEffect(() => {
    setMenuEntry(null)
  }, [files, loading, error])

  useEffect(() => {
    if (!menuEntry) return

    const closeMenu = (event: PointerEvent): void => {
      const target = event.target

      if (target instanceof Node && paneRef.current?.querySelector('.file-row.menu-open')?.contains(target)) {
        return
      }

      setMenuEntry(null)
    }

    const closeMenuWithEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenuEntry(null)
    }

    document.addEventListener('pointerdown', closeMenu)
    document.addEventListener('keydown', closeMenuWithEscape)

    return () => {
      document.removeEventListener('pointerdown', closeMenu)
      document.removeEventListener('keydown', closeMenuWithEscape)
    }
  }, [menuEntry])

  return (
    <section
      ref={paneRef}
      className='file-pane'
      data-state={directoryState}
      data-drag-over={dragOver || undefined}
      style={{ '--pane-accent': accent } as React.CSSProperties}
      onDragEnter={(event) => {
        if (!onDropFile || !event.dataTransfer.types.includes('application/x-ftp-file')) return
        event.preventDefault()
        setDragOver(true)
      }}
      onDragOver={(event) => {
        if (!onDropFile || !event.dataTransfer.types.includes('application/x-ftp-file')) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={(event) => {
        const relatedTarget = event.relatedTarget
        if (!(relatedTarget instanceof Node) || !event.currentTarget.contains(relatedTarget)) setDragOver(false)
      }}
      onDrop={(event) => {
        setDragOver(false)
        setDropTarget(null)
        if (!onDropFile) return

        event.preventDefault()
        const payload = readDraggedFile(event.dataTransfer)
        if (payload) onDropFile(payload)
      }}
    >
      <header className='pane-header'>
        <div>
          <p className='pane-label'>{label}</p>
          {onPathSubmit ? (
            <form
              className='pane-path-form'
              onSubmit={(event) => {
                event.preventDefault()
                onPathSubmit(pathInput)
              }}
            >
              <input
                value={pathInput}
                onChange={(event) => setPathInput(event.target.value)}
                aria-label='Đường dẫn cục bộ'
              />
            </form>
          ) : (
            <h2>{path}</h2>
          )}
        </div>
        <div className='pane-actions'>
          {onChoosePath && (
            <button
              className='icon-button path-picker-button'
              type='button'
              aria-label='Chọn thư mục'
              onClick={onChoosePath}
              disabled={loading}
            >
              <MoreHorizontal size={19} />
            </button>
          )}
          <button
            className='icon-button'
            type='button'
            aria-label='Thư mục cha'
            onClick={onUp}
            disabled={!onUp || loading}
          >
            <FolderUp size={18} />
          </button>
          <button
            className='icon-button'
            type='button'
            aria-label='Làm mới'
            onClick={onRefresh}
            disabled={!onRefresh || loading}
          >
            <RefreshCw size={17} />
          </button>
          {onNewFolder && (
            <button className='text-button' type='button' onClick={onNewFolder} disabled={loading}>
              <Plus size={16} />
              Thư mục mới
            </button>
          )}
        </div>
      </header>
      <div className='file-table' role='table' aria-label={`Danh sách tệp ${label}`}>
        <div className='file-table-head' role='row'>
          <span>Tên</span>
          <span>Kích thước</span>
          <span>Cập nhật</span>
          <span />
        </div>
        <div className='file-table-body'>
          {loading && <div className='pane-message'>Đang đọc thư mục…</div>}
          {!loading && error && <div className='pane-message error'>{error}</div>}
          {!loading && !error && files.length === 0 && <div className='pane-message'>Thư mục trống</div>}
          {!loading &&
            !error &&
            files.map((entry, index) => {
              const Icon = entry.kind === 'directory' ? Folder : File
              return (
                <div
                  className={`file-row ${menuEntry === entry.name ? 'menu-open' : ''} ${dropTarget === entry.name ? 'drop-target' : ''}`}
                  role='row'
                  tabIndex={0}
                  key={entry.name}
                  style={{ '--row': index } as React.CSSProperties}
                  draggable={entry.kind === 'file' && Boolean(dragSource)}
                  onDragStart={(event) => {
                    if (!dragSource || entry.kind !== 'file') return
                    setMenuEntry(null)
                    event.dataTransfer.effectAllowed = 'copy'
                    event.dataTransfer.setData('application/x-ftp-file', JSON.stringify({ source: dragSource, entry }))
                  }}
                  onDragEnter={(event) => {
                    if (entry.kind !== 'directory' || !onDropFile) return
                    event.preventDefault()
                    event.stopPropagation()
                    setDragOver(false)
                    setDropTarget(entry.name)
                  }}
                  onDragOver={(event) => {
                    if (entry.kind !== 'directory' || !onDropFile) return
                    event.preventDefault()
                    event.stopPropagation()
                    event.dataTransfer.dropEffect = 'copy'
                  }}
                  onDragLeave={(event) => {
                    const relatedTarget = event.relatedTarget
                    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) return
                    setDropTarget((current) => (current === entry.name ? null : current))
                  }}
                  onDrop={(event) => {
                    if (entry.kind !== 'directory' || !onDropFile) return
                    event.preventDefault()
                    event.stopPropagation()
                    setDropTarget(null)
                    const payload = readDraggedFile(event.dataTransfer)
                    if (payload) onDropFile(payload, entry)
                  }}
                  onDoubleClick={() => {
                    setMenuEntry(null)
                    onOpen?.(entry)
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    setMenuEntry(entry.name)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') onOpen?.(entry)
                  }}
                >
                  <span className='file-name'>
                    <span className={`file-icon ${entry.kind}`}>
                      <Icon size={18} fill='currentColor' strokeWidth={1.4} />
                    </span>
                    {entry.name}
                  </span>
                  <span className='file-meta'>{entry.size}</span>
                  <span className='file-meta'>{entry.modified}</span>
                  <button
                    className='row-menu'
                    type='button'
                    onClick={() => setMenuEntry(menuEntry === entry.name ? null : entry.name)}
                  >
                    <MoreHorizontal size={17} />
                  </button>
                  {menuEntry === entry.name && actions && actions(entry).length > 0 && (
                    <div className='file-context-menu'>
                      {actions(entry).map((action) => (
                        <button
                          className={action.destructive ? 'destructive' : ''}
                          type='button'
                          key={action.label}
                          onClick={() => {
                            setMenuEntry(null)
                            action.onSelect()
                          }}
                        >
                          {action.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
        </div>
      </div>
      <footer className='pane-footer'>
        <span>{files.length} mục</span>
        <span>{remote ? 'Phiên thụ động' : 'Ổ đĩa NTFS'}</span>
      </footer>
    </section>
  )
}
