import { useCallback, useEffect, useRef, useState } from 'react'

import type { DesktopTransferProgress, FtpSessionSnapshot } from '../shared/desktop-api'

import { ConnectionBar } from './components/connection-bar'
import { LoginDialog } from './components/login-dialog'
import { LocalPane } from './components/local-pane'
import { RemotePane } from './components/remote-pane'
import { StatusBar } from './components/status-bar'
import { TransferPanel } from './components/transfer-panel'
import type { SessionUiState, TransferItem, TransferRequest } from './types/ui-state'

function createTransferId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function App(): React.JSX.Element {
  const [url, setUrl] = useState('ftp://127.0.0.1:2121')
  const [state, setState] = useState<SessionUiState>('disconnected')
  const [identity, setIdentity] = useState<string | null>(null)
  const [loginOpen, setLoginOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [localRefreshKey, setLocalRefreshKey] = useState(0)
  const [remoteRefreshKey, setRemoteRefreshKey] = useState(0)
  const [remotePath, setRemotePath] = useState('/')
  const [transfers, setTransfers] = useState<TransferItem[]>([])
  const transfersRef = useRef<TransferItem[]>([])
  const activeTransferId = useRef<string | null>(null)
  const cancelledTransferIds = useRef(new Set<string>())

  useEffect(() => {
    transfersRef.current = transfers
  }, [transfers])

  const applySession = useCallback((session: FtpSessionSnapshot): void => {
    if (session.url) setUrl(session.url)

    if (session.state === 'disconnected') {
      setState('disconnected')
      setIdentity(null)
      setLoginOpen(false)
      return
    }

    if (session.state === 'connected') {
      setState('login-required')
      setIdentity(null)
      setLoginOpen(true)
      return
    }

    setState('connected')
    setLoginOpen(false)

    if (session.url && session.username) {
      const address = new URL(session.url)
      setIdentity(`${session.username}@${address.hostname}:${address.port || '21'}`)
    }
  }, [])

  useEffect(() => {
    let active = true

    void window.ftp
      .state()
      .then((session) => {
        if (active) applySession(session)
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause))
      })

    return () => {
      active = false
    }
  }, [applySession])

  useEffect(() => {
    const subscribe = (window.ftp as Partial<typeof window.ftp>).onTransferProgress

    if (window.desktop.bridgeVersion < 3 || typeof subscribe !== 'function') {
      setError('Preload đang dùng phiên bản cũ. Hãy đóng hoàn toàn ứng dụng Electron rồi mở lại.')
      return
    }

    return subscribe((progress: DesktopTransferProgress) => {
      setTransfers((items) =>
        items.map((item) =>
          item.id === progress.transferId
            ? {
                ...item,
                transferredBytes: progress.transferredBytes,
                totalBytes: progress.totalBytes,
                bytesPerSecond: progress.bytesPerSecond
              }
            : item
        )
      )
    })
  }, [])

  const enqueueTransfer = useCallback((request: TransferRequest): void => {
    const duplicate = transfersRef.current.some(
      (item) =>
        (item.status === 'waiting' || item.status === 'transferring') &&
        (request.direction === 'upload' ? item.remotePath === request.remotePath : item.localPath === request.localPath)
    )

    if (duplicate) {
      setError(`Đã có một lượt truyền đang chờ cho ${request.name}`)
      return
    }

    const transfer: TransferItem = {
      ...request,
      id: createTransferId(),
      status: 'waiting',
      transferredBytes: 0,
      bytesPerSecond: 0
    }

    transfersRef.current = [...transfersRef.current, transfer]
    setTransfers(transfersRef.current)
  }, [])

  useEffect(() => {
    if (state !== 'connected' || activeTransferId.current) return

    const next = transfers.find((item) => item.status === 'waiting')
    if (!next) return

    activeTransferId.current = next.id
    setTransfers((items) =>
      items.map((item) => (item.id === next.id ? { ...item, status: 'transferring', error: undefined } : item))
    )

    const input = {
      transferId: next.id,
      localPath: next.localPath,
      remotePath: next.remotePath,
      totalBytes: next.totalBytes ?? undefined
    }
    const operation = next.direction === 'upload' ? window.ftp.upload(input) : window.ftp.download(input)

    void operation
      .then(() => {
        const cancelled = cancelledTransferIds.current.has(next.id)
        setTransfers((items) =>
          items.map((item) =>
            item.id === next.id
              ? {
                  ...item,
                  status: cancelled ? 'cancelled' : 'completed',
                  transferredBytes: cancelled ? item.transferredBytes : (item.totalBytes ?? item.transferredBytes),
                  bytesPerSecond: 0
                }
              : item
          )
        )

        if (next.direction === 'upload') setRemoteRefreshKey((key) => key + 1)
        else setLocalRefreshKey((key) => key + 1)
      })
      .catch((cause) => {
        const cancelled = cancelledTransferIds.current.has(next.id)
        const message = cause instanceof Error ? cause.message : String(cause)

        setTransfers((items) =>
          items.map((item) =>
            item.id === next.id
              ? {
                  ...item,
                  status: cancelled ? 'cancelled' : 'failed',
                  error: cancelled ? undefined : message,
                  bytesPerSecond: 0
                }
              : item
          )
        )
      })
      .finally(() => {
        cancelledTransferIds.current.delete(next.id)
        activeTransferId.current = null
        setTransfers((items) => items.slice())
      })
  }, [state, transfers])

  const cancelTransfer = (transferId: string): void => {
    const transfer = transfers.find((item) => item.id === transferId)
    if (!transfer) return

    cancelledTransferIds.current.add(transferId)

    if (transfer.status === 'waiting') {
      cancelledTransferIds.current.delete(transferId)
      setTransfers((items) =>
        items.map((item) => (item.id === transferId ? { ...item, status: 'cancelled', bytesPerSecond: 0 } : item))
      )
    } else if (transfer.status === 'transferring') {
      const cancel = (window.ftp as Partial<typeof window.ftp>).cancelTransfer
      if (typeof cancel === 'function') void cancel(transferId)
    }
  }

  const retryTransfer = (transferId: string): void => {
    setTransfers((items) =>
      items.map((item) =>
        item.id === transferId
          ? {
              ...item,
              id: createTransferId(),
              status: 'waiting',
              transferredBytes: 0,
              bytesPerSecond: 0,
              error: undefined
            }
          : item
      )
    )
  }

  const connect = async (): Promise<void> => {
    setState('connecting')
    setError(null)
    try {
      applySession(await window.ftp.connect(url))
    } catch (cause) {
      setState('disconnected')
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const login = async (username: string, password: string): Promise<void> => {
    setState('logging-in')
    setError(null)
    try {
      applySession(await window.ftp.login({ username, password }))
    } catch (cause) {
      setState('login-required')
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const disconnect = async (): Promise<void> => {
    try {
      applySession(await window.ftp.disconnect())
      activeTransferId.current = null
      cancelledTransferIds.current.clear()
      transfersRef.current = []
      setError(null)
      setTransfers([])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <main className='app-shell'>
      <div className='app-window'>
        <ConnectionBar
          url={url}
          state={state}
          onUrlChange={setUrl}
          onConnect={() => void connect()}
          onDisconnect={() => void disconnect()}
        />
        {error && !loginOpen && <div className='global-error'>{error}</div>}
        <section className='workspace' aria-label='Không gian quản lý tệp'>
          <LocalPane
            connected={state === 'connected'}
            remotePath={remotePath}
            refreshKey={localRefreshKey}
            onTransfer={enqueueTransfer}
          />
          <RemotePane
            connected={state === 'connected'}
            refreshKey={remoteRefreshKey}
            onPathChange={setRemotePath}
            onTransfer={enqueueTransfer}
          />
        </section>
        <TransferPanel transfers={transfers} onCancel={cancelTransfer} onRetry={retryTransfer} />
        <StatusBar state={state} identity={identity} />
      </div>
      <LoginDialog
        open={loginOpen}
        busy={state === 'logging-in'}
        error={error}
        onClose={() => void disconnect()}
        onLogin={login}
      />
    </main>
  )
}
