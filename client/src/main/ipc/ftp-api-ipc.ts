import type { IpcMain } from 'electron'

import { IPC_CHANNEL } from '../../shared/desktop-api.ts'
import { FtpApi } from '../api/ftp-api.ts'

type Registrar = Pick<IpcMain, 'handle' | 'removeHandler'>
type ProgressWindow = {
  isDestroyed(): boolean
  webContents: { isDestroyed(): boolean; send(channel: string, ...args: unknown[]): void }
}
const registrations = new WeakMap<Registrar, () => void>()

export function registerFtpIpc(ftp: FtpApi, ipc: Registrar, windows: () => readonly ProgressWindow[] = () => []): () => void {
  registrations.get(ipc)?.()
  const channels = IPC_CHANNEL.ftp

  ipc.handle(channels.connect, (_event, url: string) => ftp.connect(url))
  ipc.handle(channels.login, (_event, credentials: { username: string; password: string }) => ftp.login(credentials))
  ipc.handle(channels.disconnect, () => ftp.disconnect())
  ipc.handle(channels.state, () => ftp.state())
  ipc.handle(channels.pwd, () => ftp.pwd())
  ipc.handle(channels.list, (_event, path?: string) => ftp.list(path))
  ipc.handle(channels.cwd, (_event, path: string) => ftp.cwd(path))
  ipc.handle(channels.cdup, () => ftp.cdup())
  ipc.handle(channels.upload, (_event, input: Parameters<FtpApi['upload']>[0]) => ftp.upload(input))
  ipc.handle(channels.download, (_event, input: Parameters<FtpApi['download']>[0]) => ftp.download(input))
  ipc.handle(channels.cancelTransfer, (_event, id: string) => ftp.cancelTransfer(id))
  ipc.handle(channels.mkdir, (_event, path: string) => ftp.mkdir(path))
  ipc.handle(channels.deleteFile, (_event, path: string) => ftp.deleteFile(path))
  ipc.handle(channels.deleteDirectory, (_event, path: string) => ftp.deleteDirectory(path))
  ipc.handle(channels.rename, (_event, input: { from: string; to: string }) => ftp.rename(input))

  const unsubscribe = ftp.onTransferProgress((progress) => {
    for (const window of windows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(channels.transferProgress, progress)
    }
  })

  const registered = Object.values(channels).filter((channel) => channel !== channels.transferProgress)
  const dispose = (): void => {
    if (registrations.get(ipc) !== dispose) return
    unsubscribe()
    for (const channel of registered) ipc.removeHandler(channel)
    registrations.delete(ipc)
  }
  registrations.set(ipc, dispose)
  return dispose
}
