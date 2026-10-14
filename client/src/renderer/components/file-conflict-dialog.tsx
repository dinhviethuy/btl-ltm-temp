import { AlertTriangle, Pencil, X } from 'lucide-react'
import { useEffect, useState } from 'react'

export type FileConflictResolution = { action: 'overwrite' } | { action: 'rename'; name: string } | { action: 'cancel' }

type FileConflictDialogProps = {
  fileName: string | null
  onResolve: (resolution: FileConflictResolution) => void
}

function suggestName(fileName: string): string {
  const dotIndex = fileName.lastIndexOf('.')
  if (dotIndex <= 0) return `${fileName} (1)`
  return `${fileName.slice(0, dotIndex)} (1)${fileName.slice(dotIndex)}`
}

export function FileConflictDialog({ fileName, onResolve }: FileConflictDialogProps): React.JSX.Element | null {
  const [renaming, setRenaming] = useState(false)
  const [nextName, setNextName] = useState('')

  useEffect(() => {
    if (!fileName) return
    setRenaming(false)
    setNextName(suggestName(fileName))
  }, [fileName])

  if (!fileName) return null

  return (
    <div className='dialog-backdrop' role='presentation'>
      <section className='login-dialog conflict-dialog' role='alertdialog' aria-modal='true'>
        <button className='dialog-close' type='button' onClick={() => onResolve({ action: 'cancel' })} aria-label='Hủy'>
          <X size={18} />
        </button>
        <span className='dialog-icon conflict-icon'>
          <AlertTriangle size={21} />
        </span>
        <p className='pane-label'>XUNG ĐỘT TÊN TỆP</p>
        <h2>Tệp đã tồn tại</h2>
        <p className='conflict-copy'>Đích đã có tệp “{fileName}”. Bạn muốn xử lý thế nào?</p>

        {renaming && (
          <label>
            Tên mới
            <input value={nextName} onChange={(event) => setNextName(event.target.value)} autoFocus />
          </label>
        )}

        <div className='conflict-actions'>
          <button className='text-button' type='button' onClick={() => onResolve({ action: 'cancel' })}>
            Hủy
          </button>
          {renaming ? (
            <button
              className='primary-button'
              type='button'
              disabled={!nextName.trim() || nextName.trim() === fileName}
              onClick={() => onResolve({ action: 'rename', name: nextName.trim() })}
            >
              Dùng tên mới
            </button>
          ) : (
            <>
              <button className='text-button' type='button' onClick={() => setRenaming(true)}>
                <Pencil size={15} />
                Đổi tên khác
              </button>
              <button className='primary-button' type='button' onClick={() => onResolve({ action: 'overwrite' })}>
                Ghi đè
              </button>
            </>
          )}
        </div>
      </section>
    </div>
  )
}
