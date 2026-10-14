import { FolderPlus, Pencil, X } from 'lucide-react'
import { useEffect, useState } from 'react'

type TextInputDialogProps = {
  open: boolean
  title: string
  label: string
  initialValue?: string
  submitLabel: string
  onClose: () => void
  onSubmit: (value: string) => void
}

export function TextInputDialog({
  open,
  title,
  label,
  initialValue = '',
  submitLabel,
  onClose,
  onSubmit
}: TextInputDialogProps): React.JSX.Element | null {
  const [value, setValue] = useState(initialValue)

  useEffect(() => {
    if (open) setValue(initialValue)
  }, [initialValue, open])

  if (!open) return null

  const isRename = submitLabel === 'Đổi tên'

  return (
    <div className='dialog-backdrop' role='presentation'>
      <form
        className='login-dialog text-input-dialog'
        onSubmit={(event) => {
          event.preventDefault()
          const nextValue = value.trim()
          if (nextValue) onSubmit(nextValue)
        }}
      >
        <button className='dialog-close' type='button' onClick={onClose} aria-label='Đóng'>
          <X size={18} />
        </button>
        <span className='dialog-icon'>{isRename ? <Pencil size={20} /> : <FolderPlus size={21} />}</span>
        <p className='pane-label'>THAO TÁC TỆP</p>
        <h2>{title}</h2>
        <label>
          {label}
          <input value={value} onChange={(event) => setValue(event.target.value)} autoFocus />
        </label>
        <button className='primary-button dialog-submit' type='submit' disabled={!value.trim()}>
          {submitLabel}
        </button>
      </form>
    </div>
  )
}
