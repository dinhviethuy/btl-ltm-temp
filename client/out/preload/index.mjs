import { contextBridge, ipcRenderer } from "electron";
const IPC_CHANNEL = {
  ftp: {
    connect: "ftp:connect",
    login: "ftp:login",
    disconnect: "ftp:disconnect",
    state: "ftp:state",
    pwd: "ftp:pwd",
    list: "ftp:list",
    cwd: "ftp:cwd",
    cdup: "ftp:cdup",
    upload: "ftp:upload",
    download: "ftp:download",
    cancelTransfer: "ftp:cancel-transfer",
    transferProgress: "ftp:transfer-progress",
    mkdir: "ftp:mkdir",
    deleteFile: "ftp:delete-file",
    deleteDirectory: "ftp:delete-directory",
    rename: "ftp:rename"
  },
  local: {
    pwd: "local:pwd",
    list: "local:list",
    cwd: "local:cwd",
    resolvePath: "local:resolve-path",
    chooseDirectory: "local:choose-directory",
    mkdir: "local:mkdir",
    rename: "local:rename",
    move: "local:move",
    deleteFile: "local:delete-file",
    deleteDirectory: "local:delete-directory"
  }
};
contextBridge.exposeInMainWorld("desktop", {
  platform: process.platform,
  bridgeVersion: 4
});
const ftp = {
  connect: (url) => ipcRenderer.invoke(IPC_CHANNEL.ftp.connect, url),
  login: (credentials) => ipcRenderer.invoke(IPC_CHANNEL.ftp.login, credentials),
  disconnect: () => ipcRenderer.invoke(IPC_CHANNEL.ftp.disconnect),
  state: () => ipcRenderer.invoke(IPC_CHANNEL.ftp.state),
  pwd: () => ipcRenderer.invoke(IPC_CHANNEL.ftp.pwd),
  list: (path) => ipcRenderer.invoke(IPC_CHANNEL.ftp.list, path),
  cwd: (path) => ipcRenderer.invoke(IPC_CHANNEL.ftp.cwd, path),
  cdup: () => ipcRenderer.invoke(IPC_CHANNEL.ftp.cdup),
  upload: (input) => ipcRenderer.invoke(IPC_CHANNEL.ftp.upload, input),
  download: (input) => ipcRenderer.invoke(IPC_CHANNEL.ftp.download, input),
  cancelTransfer: (transferId) => ipcRenderer.invoke(IPC_CHANNEL.ftp.cancelTransfer, transferId),
  onTransferProgress: (listener) => {
    const handler = (_event, progress) => {
      listener(progress);
    };
    ipcRenderer.on(IPC_CHANNEL.ftp.transferProgress, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNEL.ftp.transferProgress, handler);
  },
  mkdir: (path) => ipcRenderer.invoke(IPC_CHANNEL.ftp.mkdir, path),
  deleteFile: (path) => ipcRenderer.invoke(IPC_CHANNEL.ftp.deleteFile, path),
  deleteDirectory: (path) => ipcRenderer.invoke(IPC_CHANNEL.ftp.deleteDirectory, path),
  rename: (input) => ipcRenderer.invoke(IPC_CHANNEL.ftp.rename, input)
};
const local = {
  pwd: () => ipcRenderer.invoke(IPC_CHANNEL.local.pwd),
  list: (path) => ipcRenderer.invoke(IPC_CHANNEL.local.list, path),
  cwd: (path) => ipcRenderer.invoke(IPC_CHANNEL.local.cwd, path),
  resolvePath: (path) => ipcRenderer.invoke(IPC_CHANNEL.local.resolvePath, path),
  chooseDirectory: () => ipcRenderer.invoke(IPC_CHANNEL.local.chooseDirectory),
  mkdir: (path) => ipcRenderer.invoke(IPC_CHANNEL.local.mkdir, path),
  rename: (input) => ipcRenderer.invoke(IPC_CHANNEL.local.rename, input),
  move: (input) => ipcRenderer.invoke(IPC_CHANNEL.local.move, input),
  deleteFile: (path) => ipcRenderer.invoke(IPC_CHANNEL.local.deleteFile, path),
  deleteDirectory: (path) => ipcRenderer.invoke(IPC_CHANNEL.local.deleteDirectory, path)
};
contextBridge.exposeInMainWorld("ftp", ftp);
contextBridge.exposeInMainWorld("local", local);
