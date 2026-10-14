import { Circle } from 'lucide-react'

import type { SessionUiState } from '../types/ui-state'

type StatusBarProps = { state: SessionUiState; identity: string | null }

const platformLabel: Partial<Record<NodeJS.Platform, string>> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux'
}

export function StatusBar({ state, identity }: StatusBarProps): React.JSX.Element {
  return (
    <footer className='status-bar'>
      <span className='connection-status'>
        <Circle size={9} fill='currentColor' />
        {state === 'disconnected'
          ? 'Đã ngắt kết nối'
          : state === 'connecting'
            ? 'Đang kết nối…'
            : state === 'login-required'
              ? 'Đã kết nối · cần đăng nhập'
              : state === 'logging-in'
                ? 'Đang đăng nhập…'
                : `Đã kết nối · ${identity}`}
      </span>
      <span>Thụ động / Nhị phân</span>
      <span className='status-platform'>{platformLabel[window.desktop.platform] ?? window.desktop.platform}</span>
    </footer>
  )
}
