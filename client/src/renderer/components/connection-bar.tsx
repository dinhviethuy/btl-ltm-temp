import { Cable, Radio } from 'lucide-react'

import type { SessionUiState } from '../types/ui-state'

type ConnectionBarProps = {
  url: string
  state: SessionUiState
  onUrlChange: (url: string) => void
  onConnect: () => void
  onDisconnect: () => void
}

export function ConnectionBar({
  url,
  state,
  onUrlChange,
  onConnect,
  onDisconnect
}: ConnectionBarProps): React.JSX.Element {
  const connected = state !== 'disconnected' && state !== 'connecting'
  const busy = state === 'connecting' || state === 'logging-in'
  const label =
    state === 'connecting'
      ? 'Đang kết nối…'
      : state === 'logging-in'
        ? 'Đang đăng nhập…'
        : connected
          ? 'Ngắt kết nối'
          : 'Kết nối'
  return (
    <header className='connection-bar'>
      <div className='brand-mark' aria-hidden='true'>
        <Radio size={18} strokeWidth={2.2} />
      </div>
      <div className='connection-copy'>
        <span>ĐỊA CHỈ PHIÊN</span>
        <strong>Máy chủ từ xa / 01</strong>
      </div>
      <label className='address-field'>
        <span className='sr-only'>FTP URL</span>
        <span className='protocol'>FTP</span>
        <input
          value={url}
          onChange={(event) => onUrlChange(event.target.value)}
          aria-label='FTP URL'
          disabled={connected || busy}
        />
      </label>
      <button className='primary-button' type='button' onClick={connected ? onDisconnect : onConnect} disabled={busy}>
        <Cable size={17} />
        {label}
      </button>
    </header>
  )
}
