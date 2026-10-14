import { dialog, ipcMain } from 'electron'

import { LocalFileSystem } from '../../local/local-file-system'
import { IPC_CHANNEL, type DesktopLocalFile } from '../../shared/desktop-api'

export function registerLocalIpc(local: LocalFileSystem): () => void {
  const channels = IPC_CHANNEL.local

  ipcMain.handle(channels.pwd, () => local.lpwd())
  ipcMain.handle(channels.list, async (_event, path?: string): Promise<DesktopLocalFile[]> => {
    const files = await local.lls(path)
    return files.map((file) => ({ ...file, modifiedAt: file.modifiedAt.toISOString() }))
  })
  ipcMain.handle(channels.cwd, async (_event, path: string) => {
    await local.lcd(path)
  })
  ipcMain.handle(channels.resolvePath, (_event, path: string) => local.resolvePath(path))
  ipcMain.handle(channels.chooseDirectory, async () => {
    const result = await dialog.showOpenDialog({
      defaultPath: local.lpwd(),
      properties: ['openDirectory', 'createDirectory']
    })

    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle(channels.mkdir, async (_event, path: string) => {
    await local.mkdir(path)
  })
  ipcMain.handle(channels.rename, async (_event, input: { from: string; to: string }) => {
    await local.rename(input.from, input.to)
  })
  ipcMain.handle(
    channels.move,
    async (_event, input: { from: string; toDirectory: string; overwrite?: boolean; toName?: string }) => {
      await local.move(input.from, input.toDirectory, input.overwrite, input.toName)
    }
  )
  ipcMain.handle(channels.deleteFile, async (_event, path: string) => {
    await local.deleteFile(path)
  })
  ipcMain.handle(channels.deleteDirectory, async (_event, path: string) => {
    await local.deleteDirectory(path)
  })

  return () => {
    for (const channel of Object.values(channels)) ipcMain.removeHandler(channel)
  }
}
