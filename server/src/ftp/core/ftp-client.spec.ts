import { FtpClient } from './ftp-client'
import { ControlConnection } from './control-connection'
import { startControlServer, startTransferServer } from '../../../test/ftp-test-server'
import { PassThrough, Readable } from 'node:stream'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function withTimeout<T>(promise: Promise<T>, milliseconds = 1000): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('transfer cancellation timed out')), milliseconds)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

describe('FtpClient', () => {
  it.each(['upload', 'download'] as const)('does not send %s after cancellation while PASV was pending', async (direction) => {
    const server = await startTransferServer({ holdPasv: true, holdUpload: true, holdDownload: true })
    const client = new FtpClient()
    const controller = new AbortController()
    try {
      await client.connect(`ftp://127.0.0.1:${server.port}`)
      await client.login({ username: 'demo', password: 'secret' })
      const transfer = direction === 'upload'
        ? client.uploadStream({ remotePath: '/cancelled', stream: Readable.from([]) }, { signal: controller.signal })
        : client.downloadStream({ remotePath: '/cancelled' }, { signal: controller.signal }).then((value) => value.completion)
      const rejected = expect(withTimeout(transfer)).rejects.not.toThrow('timed out')
      for (let tries = 0; !server.commands.includes('PASV') && tries < 100; tries++) await new Promise((resolve) => setTimeout(resolve, 5))
      expect(server.commands).toContain('PASV')
      controller.abort()
      server.releasePasv()
      await rejected
      expect(server.commands.some((command) => /^(RETR|STOR|ABOR)/.test(command))).toBe(false)
    } finally { client.disconnect(); await server.close() }
  })

  it('exposes RETR acceptance separately from final completion so immediate rejection is observable before streaming', async () => {
    const server = await startTransferServer({ retrCode: 550 })
    const client = new FtpClient()
    try {
      await client.connect(`ftp://127.0.0.1:${server.port}`)
      await client.login({ username: 'demo', password: 'secret' })
      const download = await client.downloadStream({ remotePath: '/missing' })
      const accepted = (download as typeof download & { accepted?: Promise<void> }).accepted
      expect(accepted).toBeDefined()
      await expect(accepted).rejects.toThrow('RETR')
      await expect(download.completion).rejects.toThrow('RETR')
    } finally { client.disconnect(); await server.close() }
  })

  it('rejects recursive root aliases and preserves spaces in safe directory names', async () => {
    const server = await startControlServer((command, socket) => {
      socket.write(command.startsWith('USER ') ? '331 Password required\r\n'
        : command.startsWith('PASS ') ? '230 Logged in\r\n'
        : command === 'PWD' ? '257 "/home" is current directory\r\n'
        : '200 OK\r\n')
    })
    const client = new FtpClient()
    try {
      await client.connect(`ftp://127.0.0.1:${server.port}`)
      await client.login({ username: 'demo', password: 'secret' })
      const list = jest.spyOn(client, 'list').mockResolvedValue([])
      const rmd = jest.spyOn(client, 'rmd').mockResolvedValue()
      for (const path of ['/./', '/home/..', '///home//.././', '../']) {
        await expect(client.deleteDirectory(path)).rejects.toThrow('Không thể xóa thư mục gốc')
      }
      expect(list).not.toHaveBeenCalled()
      expect(rmd).not.toHaveBeenCalled()

      await client.deleteDirectory('/ report ')
      expect(list).toHaveBeenCalledWith('/ report ')
      expect(rmd).toHaveBeenCalledWith('/ report ')
    } finally {
      client.disconnect()
      await server.close()
    }
  })

  it('notifies a subscriber when the control connection closes remotely', async () => {
    const server = await startControlServer()
    const client = new FtpClient()
    try {
      await client.connect(`ftp://127.0.0.1:${server.port}`)
      const disconnected = new Promise<void>((resolve) => client.onDisconnected(resolve))
      await server.close()
      await withTimeout(disconnected)
      expect(client.getState()).toBe('disconnected')
    } finally {
      client.disconnect()
      await server.close()
    }
  })

  it('moves through connection, authentication, and disconnection states', async () => {
    const server = await startControlServer()
    const client = new FtpClient()
    try {
      expect(client.getState()).toBe('disconnected')
      await client.connect(`ftp://127.0.0.1:${server.port}`)
      expect(client.getState()).toBe('connected')
      await client.login({ username: 'demo', password: 'secret' })
      expect(client.getState()).toBe('authenticated')
      client.disconnect()
      expect(client.getState()).toBe('disconnected')
    } finally {
      client.disconnect()
      await server.close()
    }
  })

  it('closes a non-220 greeting and can retry with the same client', async () => {
    const unavailable = await startControlServer(undefined, '421 Unavailable')
    const available = await startControlServer()
    const client = new FtpClient()
    try {
      await expect(client.connect(`ftp://127.0.0.1:${unavailable.port}`)).rejects.toThrow('FTP server chưa sẵn sàng')
      expect(client.getState()).toBe('disconnected')
      await client.connect(`ftp://127.0.0.1:${available.port}`)
      expect(client.getState()).toBe('connected')
    } finally {
      client.disconnect()
      await unavailable.close()
      await available.close()
    }
  })

  it('uploads a readable stream after STOR 150 and reports progress', async () => {
    const server = await startTransferServer()
    const client = new FtpClient()
    const progress: number[] = []
    try {
      await client.connect(`ftp://127.0.0.1:${server.port}`)
      await client.login({ username: 'demo', password: 'secret' })
      await client.uploadStream({ remotePath: '/upload.bin', stream: Readable.from([Buffer.from('hello'), Buffer.from(' world')]), totalBytes: 11 }, { onProgress: (value) => progress.push(value.transferredBytes) })
      expect(Buffer.concat(server.uploads).toString()).toBe('hello world')
      expect(server.commands).toContain('STOR /upload.bin')
      expect(progress.at(-1)).toBe(11)
    } finally {
      client.disconnect()
      await server.close()
    }
  })

  it('downloads a stream and resolves completion after data and 226', async () => {
    const server = await startTransferServer({ downloadData: Buffer.from('from ftp') })
    const client = new FtpClient()
    try {
      await client.connect(`ftp://127.0.0.1:${server.port}`)
      await client.login({ username: 'demo', password: 'secret' })
      const { stream, completion } = await client.downloadStream({ remotePath: '/file.bin' })
      const chunks: Buffer[] = []
      for await (const chunk of stream) chunks.push(Buffer.from(chunk))
      await completion
      expect(Buffer.concat(chunks).toString()).toBe('from ftp')
      expect(server.commands).toContain('RETR /file.bin')
    } finally {
      client.disconnect()
      await server.close()
    }
  })

  it('rejects failed RETR and removes an incomplete local download', async () => {
    const server = await startTransferServer({ retrCode: 550 })
    const client = new FtpClient()
    const directory = await mkdtemp(join(tmpdir(), 'ftp-core-'))
    const path = join(directory, 'download.bin')
    try {
      await client.connect(`ftp://127.0.0.1:${server.port}`)
      await client.login({ username: 'demo', password: 'secret' })
      await expect(client.download({ remotePath: '/missing', localPath: path })).rejects.toThrow('RETR')
      await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      client.disconnect()
      await server.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps path-based download compatibility with a temporary file', async () => {
    const server = await startTransferServer({ downloadData: Buffer.from('saved file') })
    const client = new FtpClient()
    const directory = await mkdtemp(join(tmpdir(), 'ftp-core-'))
    const path = join(directory, 'download.bin')
    try {
      await client.connect(`ftp://127.0.0.1:${server.port}`)
      await client.login({ username: 'demo', password: 'secret' })
      await client.download({ remotePath: '/file.bin', localPath: path })
      expect(await readFile(path, 'utf8')).toBe('saved file')
    } finally {
      client.disconnect()
      await server.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps path-based upload compatibility with a temporary file', async () => {
    const server = await startTransferServer()
    const client = new FtpClient()
    const directory = await mkdtemp(join(tmpdir(), 'ftp-core-'))
    const path = join(directory, 'upload.bin')
    await writeFile(path, 'path upload')
    try {
      await client.connect(`ftp://127.0.0.1:${server.port}`)
      await client.login({ username: 'demo', password: 'secret' })
      await client.upload({ localPath: path, remotePath: '/uploaded.bin' })
      expect(Buffer.concat(server.uploads).toString()).toBe('path upload')
    } finally {
      client.disconnect()
      await server.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('removes a partial path download after cancellation', async () => {
    const server = await startTransferServer({ holdDownload: true })
    const client = new FtpClient()
    const controller = new AbortController()
    const directory = await mkdtemp(join(tmpdir(), 'ftp-core-'))
    const path = join(directory, 'partial.bin')
    try {
      await client.connect(`ftp://127.0.0.1:${server.port}`)
      await client.login({ username: 'demo', password: 'secret' })
      const download = client.download({ remotePath: '/large.bin', localPath: path }, { signal: controller.signal })
      for (let tries = 0; !server.commands.includes('RETR /large.bin') && tries < 100; tries++) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      expect(server.commands).toContain('RETR /large.bin')
      controller.abort()
      await expect(withTimeout(download)).rejects.not.toThrow('timed out')
      await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(client.getState()).toBe('authenticated')
      await client.noop()
      expect(server.commands).toContain('ABOR')
      expect(server.getControlConnections()).toBe(1)
    } finally {
      client.disconnect()
      await server.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('cancels a path upload promptly and keeps the session usable', async () => {
    const server = await startTransferServer({ holdUpload: true })
    const client = new FtpClient()
    const controller = new AbortController()
    const directory = await mkdtemp(join(tmpdir(), 'ftp-core-'))
    const path = join(directory, 'upload.bin')
    await writeFile(path, 'upload waiting for final reply')
    try {
      await client.connect(`ftp://127.0.0.1:${server.port}`)
      await client.login({ username: 'demo', password: 'secret' })
      const upload = client.upload({ localPath: path, remotePath: '/large.bin' }, { signal: controller.signal })
      for (let tries = 0; !server.commands.includes('STOR /large.bin') && tries < 100; tries++) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      expect(server.commands).toContain('STOR /large.bin')
      controller.abort()
      await expect(withTimeout(upload)).rejects.not.toThrow('timed out')
      expect(client.getState()).toBe('authenticated')
      await client.noop()
      expect(server.commands).toContain('ABOR')
      expect(server.getControlConnections()).toBe(1)
    } finally {
      client.disconnect()
      await server.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects STOR failure without consuming the input stream', async () => {
    const server = await startTransferServer({ storCode: 550 })
    const client = new FtpClient()
    const input = Readable.from([Buffer.from('must not upload')])
    try {
      await client.connect(`ftp://127.0.0.1:${server.port}`)
      await client.login({ username: 'demo', password: 'secret' })
      await expect(client.uploadStream({ remotePath: '/denied', stream: input })).rejects.toThrow('STOR thất bại: 550')
      expect(input.readableFlowing).toBeNull()
      expect(server.uploads).toHaveLength(0)
    } finally {
      input.destroy()
      client.disconnect()
      await server.close()
    }
  })

  it('cancels an active stream download and rejects completion', async () => {
    const server = await startTransferServer({ holdDownload: true })
    const client = new FtpClient()
    const controller = new AbortController()
    try {
      await client.connect(`ftp://127.0.0.1:${server.port}`)
      await client.login({ username: 'demo', password: 'secret' })
      const { stream, completion } = await client.downloadStream({ remotePath: '/large.bin' }, { signal: controller.signal })
      stream.on('error', () => undefined)
      controller.abort()
      await expect(withTimeout(completion)).rejects.toThrow()
      expect(client.getState()).toBe('authenticated')
      await client.noop()
      expect(server.commands).toContain('ABOR')
      expect(server.commands).toContain('NOOP')
      expect(server.getControlConnections()).toBe(1)
    } finally {
      client.disconnect()
      await server.close()
    }
  })

  it('resynchronizes after a single ABOR final reply without reconnecting', async () => {
    const server = await startTransferServer({ holdDownload: true, singleAbortReply: true })
    const client = new FtpClient()
    const controller = new AbortController()
    try {
      await client.connect(`ftp://127.0.0.1:${server.port}`)
      await client.login({ username: 'demo', password: 'secret' })
      const { stream, completion } = await client.downloadStream({ remotePath: '/large.bin' }, { signal: controller.signal })
      stream.on('error', () => undefined)
      controller.abort()
      await expect(withTimeout(completion)).rejects.toThrow()
      await withTimeout(client.noop())
      expect(client.getState()).toBe('authenticated')
      expect(server.commands.slice(-3)).toEqual(['ABOR', 'NOOP', 'NOOP'])
      expect(server.getControlConnections()).toBe(1)
    } finally {
      client.disconnect()
      await server.close()
    }
  })

  it('cancels an active stream upload and preserves the authenticated session', async () => {
    const server = await startTransferServer({ holdUpload: true })
    const client = new FtpClient()
    const controller = new AbortController()
    const input = new PassThrough()
    try {
      await client.connect(`ftp://127.0.0.1:${server.port}`)
      await client.login({ username: 'demo', password: 'secret' })
      const upload = client.uploadStream({ remotePath: '/large.bin', stream: input }, { signal: controller.signal })
      for (let tries = 0; !server.commands.includes('STOR /large.bin') && tries < 100; tries++) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      expect(server.commands).toContain('STOR /large.bin')
      controller.abort()
      await expect(withTimeout(upload)).rejects.toThrow()
      expect(client.getState()).toBe('authenticated')
      await client.noop()
      expect(server.commands).toContain('ABOR')
      expect(server.getControlConnections()).toBe(1)
    } finally {
      input.destroy()
      client.disconnect()
      await server.close()
    }
  })

  it('cancels a queued stream transfer behind a non-transfer command', async () => {
    const server = await startTransferServer({ holdNoop: true })
    const client = new FtpClient()
    const controller = new AbortController()
    const control = (client as unknown as { control: ControlConnection }).control
    const realCommand = control.command.bind(control)
    let blockingNoop: Promise<unknown> | undefined
    const commandSpy = jest.spyOn(control, 'command').mockImplementation((command, options) => {
      if (command.startsWith('RETR ')) blockingNoop = realCommand('NOOP')
      return realCommand(command, options)
    })
    try {
      await client.connect(`ftp://127.0.0.1:${server.port}`)
      await client.login({ username: 'demo', password: 'secret' })
      const { stream, completion } = await client.downloadStream({ remotePath: '/queued.bin' }, { signal: controller.signal })
      stream.on('error', () => undefined)
      for (let tries = 0; !server.commands.includes('NOOP') && tries < 100; tries++) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      expect(server.commands).toContain('NOOP')
      controller.abort()
      await expect(withTimeout(completion)).rejects.not.toThrow('timed out')
      expect(client.getState()).toBe('authenticated')
      server.releaseNoop()
      await blockingNoop
      await client.noop()
      expect(server.commands).not.toContain('RETR /queued.bin')
      expect(server.commands).not.toContain('ABOR')
      expect(server.getControlConnections()).toBe(1)
    } finally {
      server.releaseNoop()
      commandSpy.mockRestore()
      client.disconnect()
      await server.close()
    }
  })

  it('handles a data pipeline failure before the RETR completion reply', async () => {
    const server = await startTransferServer({ dropDataBeforeReply: true })
    const client = new FtpClient()
    try {
      await client.connect(`ftp://127.0.0.1:${server.port}`)
      await client.login({ username: 'demo', password: 'secret' })
      const { stream, completion } = await client.downloadStream({ remotePath: '/broken.bin' })
      stream.on('error', () => undefined)
      stream.resume()
      await expect(completion).rejects.toThrow()
    } finally {
      client.disconnect()
      await server.close()
    }
  })

  it('removes a path download after data resets before the RETR reply', async () => {
    const server = await startTransferServer({ dropDataBeforeReply: true })
    const client = new FtpClient()
    const directory = await mkdtemp(join(tmpdir(), 'ftp-core-'))
    const path = join(directory, 'broken.bin')
    try {
      await client.connect(`ftp://127.0.0.1:${server.port}`)
      await client.login({ username: 'demo', password: 'secret' })
      await expect(client.download({ remotePath: '/broken.bin', localPath: path })).rejects.toThrow()
      await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      client.disconnect()
      await server.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
