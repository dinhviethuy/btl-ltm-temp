import * as net from 'node:net'
import { EventEmitter } from 'node:events'

export async function startControlServer(onCommand?: (command: string, socket: net.Socket) => void | Promise<void>, greeting: string | null = '220 Ready') {
  const commands: string[] = []
  const commandEvents = new EventEmitter()
  const handledCommands = new Set<string>()
  const sockets = new Set<net.Socket>()
  let controlConnections = 0
  const server = net.createServer((socket) => {
    controlConnections++
    sockets.add(socket)
    socket.on('error', () => undefined)
    socket.on('close', () => sockets.delete(socket))
    if (greeting !== null) socket.write(`${greeting}\r\n`)
    let pending = ''
    socket.on('data', (chunk) => {
      pending += chunk.toString()
      let end: number
      while ((end = pending.indexOf('\r\n')) >= 0) {
        const command = pending.slice(0, end)
        pending = pending.slice(end + 2)
        commands.push(command)
        const handled = onCommand ? onCommand(command, socket) : undefined
        if (!onCommand) socket.write(command.startsWith('USER ') ? '331 Password required\r\n' : command.startsWith('PASS ') ? '230 Logged in\r\n' : '200 OK\r\n')
        void Promise.resolve(handled).then(() => {
          handledCommands.add(command)
          commandEvents.emit('command', command)
        })
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as net.AddressInfo
  return {
    port: address.port,
    commands,
    waitForCommand: (expected: string): Promise<void> => {
      if (handledCommands.has(expected)) return Promise.resolve()
      return new Promise((resolve) => {
        const received = (command: string) => {
          if (command !== expected) return
          commandEvents.off('command', received)
          resolve()
        }
        commandEvents.on('command', received)
      })
    },
    getControlConnections: () => controlConnections,
    releaseGreeting: () => { for (const socket of sockets) socket.write('220 Ready\r\n') },
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

export async function startTransferServer(options: { downloadData?: Buffer; retrCode?: number; retrFinalCode?: number; storCode?: number; listCode?: number; holdList?: boolean; holdDownload?: boolean; holdDownloadCompletion?: boolean; holdUpload?: boolean; holdNoop?: boolean; holdType?: boolean; holdPasv?: boolean; singleAbortReply?: boolean; dropDataBeforeReply?: boolean } = {}) {
  const dataServers = new Set<net.Server>()
  const dataSockets = new Set<net.Socket>()
  let dataServer: net.Server | undefined
  let dataSocket: net.Socket | undefined
  let heldNoop: net.Socket | undefined
  let heldCompletion: net.Socket | undefined
  let releasePasv: (() => void) | undefined
  let heldType: net.Socket | undefined
  let releaseList: (() => void) | undefined
  let noopHeldOnce = false
  const uploads: Buffer[] = []
  const server = await startControlServer(async (command, control) => {
    if (command.startsWith('USER ')) { control.write('331 Password required\r\n'); return }
    if (command.startsWith('PASS ')) { control.write('230 Logged in\r\n'); return }
    if (command === 'NOOP' && options.holdNoop && !noopHeldOnce) {
      noopHeldOnce = true
      heldNoop = control
      return
    }
    if (command === 'TYPE I') {
      if (options.holdType) heldType = control
      else control.write('200 Binary mode\r\n')
      return
    }
    if (command === 'PASV') {
      dataServer = net.createServer((socket) => {
        dataSocket = socket
        dataSockets.add(socket)
        socket.on('close', () => dataSockets.delete(socket))
        socket.on('error', () => undefined)
      })
      dataServers.add(dataServer)
      await new Promise<void>((resolve) => dataServer!.listen(0, '127.0.0.1', resolve))
      const port = (dataServer.address() as net.AddressInfo).port
      const respond = () => control.write(`227 Entering Passive Mode (127,0,0,1,${Math.floor(port / 256)},${port % 256})\r\n`)
      if (options.holdPasv) releasePasv = respond
      else respond()
      return
    }
    if (command.startsWith('RETR ')) {
      if (options.retrCode) { control.write(`${options.retrCode} Failed\r\n`); return }
      control.write('150 Opening data\r\n')
      if (options.retrFinalCode) {
        setTimeout(() => { if (!control.destroyed) control.write(`${options.retrFinalCode} Failed after acceptance\r\n`) }, 20)
        return
      }
      if (options.holdDownload) {
        return
      }
      if (options.dropDataBeforeReply) {
        dataSocket!.resetAndDestroy()
        setTimeout(() => { if (!control.destroyed) control.write('226 Transfer complete\r\n') }, 30)
        return
      }
      dataSocket!.end(options.downloadData ?? Buffer.from('downloaded bytes'), () => {
        if (options.holdDownloadCompletion) heldCompletion = control
        else control.write('226 Transfer complete\r\n')
      })
      return
    }
    if (command === 'LIST' || command.startsWith('LIST ')) {
      if (options.listCode) { control.write(`${options.listCode} Listing failed\r\n`); return }
      control.write('150 Listing\r\n')
      const socket = dataSocket!
      if (options.dropDataBeforeReply) {
        socket.resetAndDestroy()
        setTimeout(() => { if (!control.destroyed) control.write('226 Listing complete\r\n') }, 30)
        return
      }
      const finish = () => socket.end('', () => control.write('226 Listing complete\r\n'))
      if (options.holdList) releaseList = finish
      else finish()
      return
    }
    if (command.startsWith('RMD ')) { control.write('250 Directory removed\r\n'); return }
    if (command.startsWith('STOR ')) {
      if (options.storCode) { control.write(`${options.storCode} Failed\r\n`); return }
      control.write('150 Opening data\r\n')
      dataSocket!.on('data', (chunk: Buffer) => uploads.push(chunk))
      if (!options.holdUpload) dataSocket!.on('end', () => control.write('226 Transfer complete\r\n'))
      return
    }
    if (command === 'ABOR') {
      control.write(options.singleAbortReply ? '226 Abort successful\r\n' : '426 Transfer aborted\r\n226 Abort successful\r\n')
      return
    }
    control.write('200 OK\r\n')
  })
  return {
    ...server,
    uploads,
    releaseList: () => releaseList?.(),
    releaseType: () => heldType?.write('200 Binary mode\r\n'),
    releasePasv: () => releasePasv?.(),
    releaseDownload: (code = 226) => heldCompletion?.write(`${code} Transfer finished\r\n`),
    releaseNoop: () => {
      const socket = heldNoop
      heldNoop = undefined
      socket?.write('200 OK\r\n')
    },
    close: async () => {
      for (const socket of dataSockets) socket.destroy()
      await Promise.all([...dataServers].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
      await server.close()
    }
  }
}
