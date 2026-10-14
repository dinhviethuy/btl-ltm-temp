import { ControlConnection } from './control-connection'
import { startControlServer } from '../../../test/ftp-test-server'

async function withinOneSecond<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('control resynchronization timed out')), 1000)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

describe('ControlConnection', () => {
  it('rejects CR/LF commands before any bytes are written and keeps the connection usable', async () => {
    const server = await startControlServer()
    const control = new ControlConnection()
    try {
      await control.connect({ host: '127.0.0.1', port: server.port })
      for (const command of ['USER demo\r', 'PASS secret\n', 'PASS secret\r\nDELE /victim']) {
        await expect(control.command(command)).rejects.toThrow('CR or LF')
      }
      expect((await control.command('NOOP')).code).toBe(200)
      expect(server.commands).toEqual(['NOOP'])
    } finally { control.close(); await server.close() }
  })

  it('receives the greeting and replies to commands', async () => {
    const server = await startControlServer()
    const control = new ControlConnection()
    try {
      expect((await control.connect({ host: '127.0.0.1', port: server.port })).code).toBe(220)
      expect((await control.command('USER demo')).code).toBe(331)
      expect((await control.command('PASS secret')).code).toBe(230)
      expect(server.commands).toEqual(['USER demo', 'PASS secret'])
    } finally {
      control.close()
      await server.close()
    }
  })

  it('times out a command and rejects queued work', async () => {
    const server = await startControlServer(() => undefined)
    const control = new ControlConnection()
    try {
      await control.connect({ host: '127.0.0.1', port: server.port })
      const first = control.command('NOOP', { timeoutMs: 20 })
      const second = control.command('PWD')
      await expect(first).rejects.toThrow('FTP command timeout: NOOP')
      await expect(second).rejects.toThrow('FTP command timeout: NOOP')
    } finally {
      control.close()
      await server.close()
    }
  })

  it('consumes 426 then 226 for ABOR before sending the next command', async () => {
    let abortCompleted = false
    let nextArrivedEarly = false
    let waitingProbe: (() => void) | undefined
    const server = await startControlServer((command, socket) => {
      if (command.startsWith('RETR ')) socket.write('150 Opening data\r\n')
      else if (command === 'ABOR') {
        socket.write('426 Transfer aborted\r\n')
        setTimeout(() => {
          abortCompleted = true
          socket.write('226 Abort successful\r\n')
          waitingProbe?.()
        }, 10)
      } else if (command === 'NOOP') {
        if (abortCompleted) socket.write('200 Probe OK\r\n')
        else waitingProbe = () => socket.write('200 Probe OK\r\n')
      } else if (command === 'PWD') {
        nextArrivedEarly = !abortCompleted
        socket.write('257 "/"\r\n')
      }
    })
    const control = new ControlConnection()
    try {
      await control.connect({ host: '127.0.0.1', port: server.port })
      let preliminary!: () => void
      const opened = new Promise<void>((resolve) => { preliminary = resolve })
      const transfer = control.command('RETR /large.bin', { onPreliminary: preliminary })
      await opened
      const abort = control.abortTransfer()
      const next = control.command('PWD')
      void next.catch(() => undefined)
      await expect(transfer).rejects.toThrow('aborted')
      await withinOneSecond(abort)
      expect((await next).code).toBe(257)
      expect(server.commands).toEqual(['RETR /large.bin', 'ABOR', 'NOOP', 'PWD'])
      expect(nextArrivedEarly).toBe(false)
    } finally {
      control.close()
      await server.close()
    }
  })

  it('accepts a single 226 when ABOR finds no transfer in progress', async () => {
    const server = await startControlServer((command, socket) => {
      if (command === 'ABOR') socket.write('226 Abort successful\r\n')
      else if (command === 'NOOP') socket.write('200 OK\r\n')
      else if (command === 'PWD') socket.write('257 "/"\r\n')
    })
    const control = new ControlConnection()
    try {
      await control.connect({ host: '127.0.0.1', port: server.port })
      await expect(withinOneSecond(control.abortTransfer())).resolves.toBeUndefined()
      expect((await control.command('PWD')).code).toBe(257)
      expect(server.commands).toEqual(['ABOR', 'NOOP', 'PWD'])
    } finally {
      control.close()
      await server.close()
    }
  })

  it.each(['RETR /retry.bin', 'MLSD'])('resynchronizes ABOR with one final reply and permits a subsequent %s', async (retryCommand) => {
    const server = await startControlServer((command, socket) => {
      if (command === retryCommand) socket.write('150 Opening data\r\n226 Transfer complete\r\n')
      else if (command.startsWith('RETR ')) socket.write('150 Opening data\r\n')
      else if (command === 'ABOR') socket.write('226 Abort successful\r\n')
      else if (command === 'NOOP') socket.write('200 Probe OK\r\n')
      else if (command === 'PWD') socket.write('257 "/"\r\n')
    })
    const control = new ControlConnection()
    try {
      await control.connect({ host: '127.0.0.1', port: server.port })
      let preliminary!: () => void
      const opened = new Promise<void>((resolve) => { preliminary = resolve })
      const transfer = control.command('RETR /single.bin', { onPreliminary: preliminary })
      await opened
      const rejected = expect(transfer).rejects.toThrow('aborted')
      const abort = control.abortTransfer()
      const next = control.command('PWD')
      void next.catch(() => undefined)
      await rejected
      await withinOneSecond(abort)
      expect((await next).code).toBe(257)
      expect((await control.command(retryCommand)).code).toBe(226)
      expect(server.commands).toEqual(['RETR /single.bin', 'ABOR', 'NOOP', 'PWD', retryCommand])
      expect(server.getControlConnections()).toBe(1)
    } finally {
      control.close()
      await server.close()
    }
  })

  it.each(['RETR /queued.bin', 'STOR /queued.bin'])('removes queued %s while an unrelated command is active', async (transferCommand) => {
    let releaseNoop!: () => void
    const waiting = new Promise<void>((resolve) => { releaseNoop = resolve })
    const server = await startControlServer((command, socket) => {
      if (command === 'NOOP') void waiting.then(() => socket.write('200 OK\r\n'))
      else if (command === 'PWD') socket.write('257 "/"\r\n')
    })
    const control = new ControlConnection()
    try {
      await control.connect({ host: '127.0.0.1', port: server.port })
      const noop = control.command('NOOP')
      const transfer = control.command(transferCommand)
      const rejected = expect(transfer).rejects.toThrow('aborted')
      await expect(control.abortTransfer()).resolves.toBeUndefined()
      await rejected
      releaseNoop()
      expect((await noop).code).toBe(200)
      expect((await control.command('PWD')).code).toBe(257)
      expect(server.commands).toEqual(['NOOP', 'PWD'])
    } finally {
      releaseNoop()
      control.close()
      await server.close()
    }
  })

  it('uses an ordered server\'s NOOP reply as the barrier after separate transfer and ABOR replies', async () => {
    let abortFinalSent = false
    let nextArrivedEarly = false
    let probeReachedServer = false
    let waitingProbe: (() => void) | undefined
    const server = await startControlServer((command, socket) => {
      if (command.startsWith('RETR ')) socket.write('150 Opening data\r\n')
      else if (command === 'ABOR') {
        socket.write('226 Transfer complete\r\n')
        setTimeout(() => {
          abortFinalSent = true
          socket.write('226 Abort successful\r\n')
          waitingProbe?.()
        }, 20)
      } else if (command === 'NOOP') {
        probeReachedServer = true
        // Interoperability contract: the server queues NOOP behind ABOR and
        // emits ABOR's final reply first, even if NOOP arrives before it.
        if (abortFinalSent) socket.write('200 Probe OK\r\n')
        else waitingProbe = () => socket.write('200 Probe OK\r\n')
      } else if (command === 'PWD') {
        nextArrivedEarly = !abortFinalSent
        socket.write('257 "/"\r\n')
      }
    })
    const control = new ControlConnection()
    try {
      await control.connect({ host: '127.0.0.1', port: server.port })
      let preliminary!: () => void
      const opened = new Promise<void>((resolve) => { preliminary = resolve })
      const transfer = control.command('RETR /raced.bin', { onPreliminary: preliminary })
      await opened
      const rejected = expect(transfer).rejects.toThrow('aborted')
      const abort = control.abortTransfer()
      const next = control.command('PWD')
      void next.catch(() => undefined)
      await rejected
      await withinOneSecond(abort)
      expect((await next).code).toBe(257)
      expect(nextArrivedEarly).toBe(false)
      expect(probeReachedServer).toBe(true)
      expect(server.commands).toEqual(['RETR /raced.bin', 'ABOR', 'NOOP', 'PWD'])
    } finally {
      control.close()
      await server.close()
    }
  })

  it('fails closed when an ABOR reply arrives after the probe and would satisfy PWD', async () => {
    const server = await startControlServer((command, socket) => {
      if (command.startsWith('RETR ')) socket.write('150 Opening data\r\n')
      else if (command === 'ABOR') socket.write('226 Transfer complete\r\n')
      else if (command === 'NOOP') socket.write('200 Probe OK\r\n')
      else if (command === 'PWD') {
        // Deliberately violate the ordered-dialogue contract. Waiting until
        // PWD arrives proves the late ABOR reply follows the probe's 200;
        // no timer or TCP-chunk boundary determines the ordering.
        socket.write('226 Late abort completion\r\n257 "/"\r\n')
      }
    })
    const control = new ControlConnection()
    try {
      await control.connect({ host: '127.0.0.1', port: server.port })
      let preliminary!: () => void
      const opened = new Promise<void>((resolve) => { preliminary = resolve })
      const transfer = control.command('RETR /raced.bin', { onPreliminary: preliminary })
      await opened
      const rejected = expect(transfer).rejects.toThrow('aborted')
      const abort = control.abortTransfer()
      const next = control.command('PWD')
      const queued = control.command('TYPE I')
      const outcomes = Promise.allSettled([next, queued])
      await rejected
      await withinOneSecond(abort)
      expect(await withinOneSecond(outcomes)).toEqual([
        { status: 'rejected', reason: expect.objectContaining({ message: expect.stringContaining('out of sequence') }) },
        { status: 'rejected', reason: expect.objectContaining({ message: expect.stringContaining('out of sequence') }) }
      ])
      await expect(control.command('NOOP')).rejects.toThrow('Chưa kết nối')
      expect(server.commands).toEqual(['RETR /raced.bin', 'ABOR', 'NOOP', 'PWD'])
    } finally {
      control.close()
      await server.close()
    }
  })

  it('closes on a late ABOR reply after the probe when no command is active', async () => {
    let sendLateAbortReply!: () => void
    let disconnected!: (error: Error) => void
    const closed = new Promise<Error>((resolve) => { disconnected = resolve })
    const server = await startControlServer((command, socket) => {
      if (command === 'ABOR') socket.write('226 Abort successful\r\n')
      else if (command === 'NOOP') {
        sendLateAbortReply = () => { socket.write('226 Late abort completion\r\n') }
        socket.write('200 Probe OK\r\n')
      }
    })
    const control = new ControlConnection(disconnected)
    try {
      await control.connect({ host: '127.0.0.1', port: server.port })
      await withinOneSecond(control.abortTransfer())
      sendLateAbortReply()
      expect((await withinOneSecond(closed)).message).toContain('out of sequence')
      await expect(control.command('PWD')).rejects.toThrow('Chưa kết nối')
      expect(server.commands).toEqual(['ABOR', 'NOOP'])
    } finally {
      control.close()
      await server.close()
    }
  })
})
