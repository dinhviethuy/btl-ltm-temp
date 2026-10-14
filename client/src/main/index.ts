import { join } from 'node:path'

import { app, BrowserWindow, ipcMain, Menu, shell } from 'electron'

import { LocalFileSystem } from '../local/local-file-system'
import { ApiClient } from './api/api-client'
import { FtpApi } from './api/ftp-api'
import { TransferSocket, transferSocketBaseUrl } from './api/transfer-socket'
import { registerFtpIpc } from './ipc/ftp-api-ipc'
import { registerLocalIpc } from './ipc/local-ipc'
import { createExternalLinkHandler } from './external-links'
import { createShutdownHandler } from './shutdown'

let disposeIpc: (() => Promise<void>) | null = null

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 640,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f3efe6',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  window.removeMenu()

  window.once('ready-to-show', () => {
    window.show()
  })

  window.webContents.setWindowOpenHandler(createExternalLinkHandler((url) => shell.openExternal(url)))

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null)

  const local = new LocalFileSystem(app.getPath('downloads'))
  const disposeLocal = registerLocalIpc(local)
  const apiBaseUrl = process.env.FTP_API_BASE_URL ?? 'http://127.0.0.1:3000/api'
  const socket = new TransferSocket(transferSocketBaseUrl(apiBaseUrl, process.env.FTP_WS_BASE_URL))
  const ftp = new FtpApi(new ApiClient(apiBaseUrl), socket)
  const disposeFtp = registerFtpIpc(ftp, ipcMain, () => BrowserWindow.getAllWindows())
  disposeIpc = async () => {
    disposeFtp()
    disposeLocal()
    await ftp.disconnect()
  }

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', createShutdownHandler(async () => {
  await disposeIpc?.()
  disposeIpc = null
}, () => app.quit()))
