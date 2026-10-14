import { KeyRound, X } from 'lucide-react'
import { useState } from 'react'

type LoginDialogProps = {
  open: boolean
  busy: boolean
  error: string | null
  onClose: () => void
  onLogin: (username: string, password: string) => Promise<void>
}

export function LoginDialog({ open, busy, error, onClose, onLogin }: LoginDialogProps): React.JSX.Element | null {
  const [username, setUsername] = useState('dvh')
  const [password, setPassword] = useState('')

  if (!open) return null

  return (
    <div className='dialog-backdrop' role='presentation'>
      <form
        className='login-dialog'
        onSubmit={(event) => {
          event.preventDefault()
          void onLogin(username, password)
        }}
      >
        <button className='dialog-close' type='button' onClick={onClose} aria-label='Đóng'>
          <X size={18} />
        </button>
        <span className='dialog-icon'>
          <KeyRound size={21} />
        </span>
        <p className='pane-label'>XÁC THỰC</p>
        <h2>Đăng nhập máy chủ</h2>
        <label>
          Tên đăng nhập
          <input value={username} onChange={(event) => setUsername(event.target.value)} autoFocus />
        </label>
        <label>
          Mật khẩu
          <input type='password' value={password} onChange={(event) => setPassword(event.target.value)} />
        </label>
        {error && <p className='form-error'>{error}</p>}
        <button className='primary-button dialog-submit' type='submit' disabled={busy || !username.trim()}>
          {busy ? 'Đang đăng nhập…' : 'Đăng nhập'}
        </button>
      </form>
    </div>
  )
}
