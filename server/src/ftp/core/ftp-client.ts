import net from 'node:net'
import { AsyncLocalStorage } from 'node:async_hooks'
import { posix } from 'node:path'

import { createReadStream, createWriteStream } from 'node:fs'
import { rm, stat } from 'node:fs/promises'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { FTP_TIMEOUT } from './constants'
import { ControlConnection } from './control-connection'
import { DataConnection } from './data-connection'
import { parseList } from './list-parser'
import { parsePasvReply } from './passive'
import { FtpReply, PassiveAddress, RemoteFile } from './types'

export type FtpClientState = 'disconnected' | 'connected' | 'authenticated'

export type TransferProgress = {
  transferredBytes: number
  totalBytes: number | null
}

export type TransferOptions = {
  signal?: AbortSignal
  totalBytes?: number
  onProgress?: (progress: TransferProgress) => void
}

export class FtpClient {
  private readonly control: ControlConnection
  private readonly dataConnection: DataConnection
  private readonly disconnectedListeners = new Set<() => void>()
  private readonly operationScope = new AsyncLocalStorage<{ active: boolean }>()
  private operationTail: Promise<void> = Promise.resolve()
  private connectionGeneration = 0
  private state: FtpClientState = 'disconnected'

  constructor() {
    this.dataConnection = new DataConnection()

    this.control = new ControlConnection(() => {
      this.connectionGeneration++
      this.dataConnection.close()
      const wasConnected = this.state !== 'disconnected'
      this.state = 'disconnected'
      if (wasConnected) {
        for (const listener of this.disconnectedListeners) listener()
      }
    })
  }

  getState(): FtpClientState {
    return this.state
  }

  onDisconnected(listener: () => void): () => void {
    this.disconnectedListeners.add(listener)
    return () => { this.disconnectedListeners.delete(listener) }
  }

  /** Serialize complete operations; nested core calls share their owner's turn. */
  runOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.operationScope.getStore()?.active) return operation()
    const generation = this.connectionGeneration
    const result = this.operationTail.then(() => {
      if (generation !== this.connectionGeneration) throw new Error('FTP control connection đã đóng')
      const scope = { active: true }
      return this.operationScope.run(scope, async () => {
        try { return await operation() }
        finally { scope.active = false }
      })
    })
    // A failed operation must not block subsequent turns or leak a rejection.
    this.operationTail = result.then(() => undefined, () => undefined)
    return result
  }

  async uploadStream(
    input: { remotePath: string; stream: NodeJS.ReadableStream; totalBytes?: number },
    options: TransferOptions = {}
  ): Promise<void> {
    return this.runOperation(() => this.uploadStreamOperation(input, options))
  }

  private async uploadStreamOperation(
    input: { remotePath: string; stream: NodeJS.ReadableStream; totalBytes?: number },
    options: TransferOptions
  ): Promise<void> {
    this.ensureAuthenticated()
    if (!input.remotePath.trim()) throw new Error('Remote path không được để trống')
    options.signal?.throwIfAborted()
    await this.setBinaryType()
    options.signal?.throwIfAborted()

    const dataSocket = await this.openPassiveDataConnection()
    if (options.signal?.aborted) {
      this.dataConnection.close()
      options.signal.throwIfAborted()
    }
    const stopOnAbort = () => this.cancelActiveTransfer()
    options.signal?.addEventListener('abort', stopOnAbort, { once: true })

    try {
      let startTransfer: (() => void) | undefined
      const preliminaryPromise = new Promise<void>((resolve) => { startTransfer = resolve })
      const commandPromise = this.control.command(`STOR ${input.remotePath}`, {
        timeoutMs: FTP_TIMEOUT.transfer,
        onPreliminary: (reply) => {
          if (reply.code === 125 || reply.code === 150) startTransfer?.()
        }
      })
      const firstResult = await Promise.race([
        preliminaryPromise.then(() => ({ type: 'preliminary' as const })),
        commandPromise.then((reply) => ({ type: 'final' as const, reply }))
      ])
      if (firstResult.type === 'final') {
        this.dataConnection.close()
        throw new Error(`STOR thất bại: ${firstResult.reply.code} ${firstResult.reply.message}`)
      }

      const progress = this.createProgressStream(input.totalBytes ?? options.totalBytes ?? null, options.onProgress)
      try {
        await pipeline(input.stream, progress, dataSocket, { signal: options.signal })
      } catch (error) {
        this.dataConnection.close()
        await commandPromise.catch(() => undefined)
        throw error
      }
      const finalReply = await commandPromise
      if (finalReply.code !== 226 && finalReply.code !== 250) {
        throw new Error(`STOR thất bại: ${finalReply.code} ${finalReply.message}`)
      }
    } finally {
      options.signal?.removeEventListener('abort', stopOnAbort)
      this.dataConnection.close()
    }
  }

  async downloadStream(
    input: { remotePath: string },
    options: TransferOptions = {}
  ): Promise<{ stream: NodeJS.ReadableStream; accepted: Promise<void>; completion: Promise<void> }> {
    return new Promise((resolve, reject) => {
      void this.runOperation(async () => {
        const transfer = await this.downloadStreamOperation(input, options)
        // Return the readable immediately, retaining the turn until completion.
        resolve(transfer)
        await transfer.completion
      }).catch(reject)
    })
  }

  private async downloadStreamOperation(
    input: { remotePath: string },
    options: TransferOptions
  ): Promise<{ stream: NodeJS.ReadableStream; accepted: Promise<void>; completion: Promise<void> }> {
    this.ensureAuthenticated()
    if (!input.remotePath.trim()) throw new Error('Remote path không được để trống')
    options.signal?.throwIfAborted()
    await this.setBinaryType()
    options.signal?.throwIfAborted()

    const dataSocket = await this.openPassiveDataConnection()
    if (options.signal?.aborted) {
      this.dataConnection.close()
      options.signal.throwIfAborted()
    }
    const progress = this.createProgressStream(options.totalBytes ?? null, options.onProgress)
    const stopOnAbort = () => this.cancelActiveTransfer()
    options.signal?.addEventListener('abort', stopOnAbort, { once: true })

    let accept!: () => void
    let rejectAcceptance!: (error: unknown) => void
    const accepted = new Promise<void>((resolve, reject) => { accept = resolve; rejectAcceptance = reject })
    void accepted.catch(() => undefined)
    const transferPromise = pipeline(dataSocket, progress, { signal: options.signal })
    void transferPromise.catch(() => undefined)
    const completion = (async () => {
      try {
        const finalReply = await this.control.command(`RETR ${input.remotePath}`, {
          timeoutMs: FTP_TIMEOUT.transfer,
          onPreliminary: (reply) => { if (reply.code === 125 || reply.code === 150) accept() }
        })
        if (finalReply.code !== 226) {
          this.dataConnection.close()
          await transferPromise.catch(() => undefined)
          throw new Error(`RETR thất bại: ${finalReply.code} ${finalReply.message}`)
        }
        accept()
        await transferPromise
      } catch (error) {
        rejectAcceptance(error)
        this.dataConnection.close()
        await transferPromise.catch(() => undefined)
        throw error
      } finally {
        options.signal?.removeEventListener('abort', stopOnAbort)
        this.dataConnection.close()
      }
    })()
    void completion.catch(() => undefined)
    return { stream: progress, accepted, completion }
  }

  async download(
    input: { remotePath: string; localPath: string },
    options: TransferOptions = {}
  ): Promise<void> {
    return this.runOperation(() => this.downloadOperation(input, options))
  }

  private async downloadOperation(
    { remotePath, localPath }: { remotePath: string; localPath: string },
    options: TransferOptions
  ): Promise<void> {
    this.ensureAuthenticated()

    if (!remotePath.trim()) {
      throw new Error('Remote path không được để trống')
    }

    if (!localPath.trim()) {
      throw new Error('Local path không được để trống')
    }

    await this.setBinaryType()
    options.signal?.throwIfAborted()

    const dataSocket = await this.openPassiveDataConnection()
    const stopOnAbort = () => this.cancelActiveTransfer()
    options.signal?.addEventListener('abort', stopOnAbort, { once: true })

    const writeStream = createWriteStream(localPath)
    const progressStream = this.createProgressStream(options.totalBytes ?? null, options.onProgress)

    /*
     * Gắn pipeline TRƯỚC khi gửi RETR.
     *
     * Khi server bắt đầu gửi data thì
     * listener/stream đã sẵn sàng.
     */
    const transferPromise = pipeline(dataSocket, progressStream, writeStream, { signal: options.signal })
    void transferPromise.catch(() => undefined)

    try {
      const finalReply = await this.control.command(`RETR ${remotePath}`, {
        timeoutMs: FTP_TIMEOUT.transfer
      })

      if (finalReply.code !== 226) {
        /*
         * Ví dụ:
         * 550 File not found
         *
         * Server không transfer nữa,
         * nên phải đóng data socket.
         */
        this.dataConnection.close()

        await transferPromise.catch(() => undefined)

        await rm(localPath, { force: true })

        throw new Error(`RETR thất bại: ${finalReply.code} ${finalReply.message}`)
      }

      /*
       * 226 đã về nhưng vẫn đảm bảo
       * filesystem stream đã flush xong.
       */
      await transferPromise
    } catch (error) {
      this.dataConnection.close()

      await transferPromise.catch(() => undefined)

      /*
       * Không giữ file download dở.
       */
      await rm(localPath, { force: true })

      throw error
    } finally {
      options.signal?.removeEventListener('abort', stopOnAbort)
      this.dataConnection.close()
    }
  }

  async upload(
    input: { localPath: string; remotePath: string },
    options: TransferOptions = {}
  ): Promise<void> {
    return this.runOperation(() => this.uploadOperation(input, options))
  }

  private async uploadOperation(
    { localPath, remotePath }: { localPath: string; remotePath: string },
    options: TransferOptions
  ): Promise<void> {
    this.ensureAuthenticated()

    if (!localPath.trim()) {
      throw new Error('Local path không được để trống')
    }

    if (!remotePath.trim()) {
      throw new Error('Remote path không được để trống')
    }

    /*
     * Kiểm tra trước khi PASV/STOR.
     */
    const fileStat = await stat(localPath)

    if (!fileStat.isFile()) {
      throw new Error('Local path không phải file')
    }

    options.signal?.throwIfAborted()

    await this.setBinaryType()

    const dataSocket = await this.openPassiveDataConnection()
    const stopOnAbort = () => this.cancelActiveTransfer()
    options.signal?.addEventListener('abort', stopOnAbort, { once: true })

    try {
      let startTransfer: (() => void) | null = null

      const preliminaryPromise = new Promise<void>((resolve) => {
        startTransfer = resolve
      })

      const commandPromise = this.control.command(`STOR ${remotePath}`, {
        timeoutMs: FTP_TIMEOUT.transfer,
        onPreliminary: (reply) => {
          if (reply.code === 125 || reply.code === 150) {
            startTransfer?.()
          }
        }
      })

      /*
       * Có 2 khả năng:
       *
       * 150 → bắt đầu upload
       *
       * hoặc
       *
       * 550 → STOR lỗi ngay, không có 150.
       */
      const firstResult = await Promise.race([
        preliminaryPromise.then(() => ({
          type: 'preliminary' as const
        })),

        commandPromise.then((reply) => ({
          type: 'final' as const,
          reply
        }))
      ])

      if (firstResult.type === 'final') {
        this.dataConnection.close()

        throw new Error(`STOR thất bại: ${firstResult.reply.code} ${firstResult.reply.message}`)
      }

      /*
       * Server đã trả 125/150.
       * Bắt đầu gửi file.
       */
      const readStream = createReadStream(localPath)
      const progressStream = this.createProgressStream(fileStat.size, options.onProgress)

      try {
        await pipeline(readStream, progressStream, dataSocket, { signal: options.signal })
      } catch (error) {
        this.dataConnection.close()
        await commandPromise.catch(() => undefined)
        throw error
      }

      /*
       * File bytes đã gửi xong.
       * Chờ FTP completion reply.
       */
      const finalReply = await commandPromise

      if (finalReply.code !== 226 && finalReply.code !== 250) {
        throw new Error(`STOR thất bại: ${finalReply.code} ${finalReply.message}`)
      }
    } finally {
      options.signal?.removeEventListener('abort', stopOnAbort)
      this.dataConnection.close()
    }
  }

  async connect(input: string): Promise<FtpReply> {
    return this.runOperation(() => this.connectOperation(input))
  }

  private async connectOperation(input: string): Promise<FtpReply> {
    if (this.state !== 'disconnected') {
      throw new Error('FTP client đã kết nối')
    }
    const url = new URL(input)

    if (url.protocol !== 'ftp:') {
      throw new Error('URL phải sử dụng ftp://')
    }
    const host = url.hostname
    if (!host) {
      throw new Error('FTP host không hợp lệ')
    }
    const port = url.port ? Number(url.port) : 21
    const generation = this.connectionGeneration
    const greeting = await this.control.connect({ host, port })
    if (generation !== this.connectionGeneration) throw new Error('FTP control connection đã đóng')
    if (greeting.code !== 220) {
      this.control.close()
      throw new Error(`FTP server chưa sẵn sàng: ${greeting.code} ${greeting.message}`)
    }
    this.state = 'connected'
    return greeting
  }

  async login(credentials: { username: string; password?: string }): Promise<FtpReply> {
    return this.runOperation(() => this.loginOperation(credentials))
  }

  private async loginOperation({ username, password }: { username: string; password?: string }): Promise<FtpReply> {
    if (this.state !== 'connected') {
      throw new Error('FTP client chưa ở trạng thái connected')
    }
    if (!username.trim()) {
      throw new Error('Username không được để trống')
    }
    const userReply = await this.control.command(`USER ${username}`)

    // Server không yêu cầu password
    if (userReply.code === 230) {
      this.state = 'authenticated'
      return userReply
    }

    if (userReply.code === 331) {
      if (password === undefined) {
        throw new Error('FTP server yêu cầu password')
      }
      const passReply = await this.control.command(`PASS ${password}`)
      if (passReply.code === 230) {
        this.state = 'authenticated'
        return passReply
      }
      if (passReply.code === 332) {
        throw new Error('FTP server yêu cầu ACCOUNT, hiện chưa hỗ trợ')
      }
      throw new Error(`Đăng nhập thất bại: ${passReply.code} ${passReply.message}`)
    }
    if (userReply.code === 332) {
      throw new Error('FTP server yêu cầu ACCOUNT, hiện chưa hỗ trợ')
    }
    throw new Error(`USER thất bại: ${userReply.code} ${userReply.message}`)
  }

  disconnect(): void {
    this.dataConnection.close()
    this.control.close()
    this.state = 'disconnected'
  }

  async list(path?: string): Promise<RemoteFile[]> {
    return this.runOperation(() => this.listOperation(path))
  }

  private async listOperation(path?: string): Promise<RemoteFile[]> {
    this.ensureAuthenticated()
    const raw = await this.listRaw(path)
    return parseList(raw)
  }

  private async listRaw(path?: string): Promise<string> {
    this.ensureAuthenticated()
    const dataSocket = await this.openPassiveDataConnection()
    const dataPromise = this.readDataSocket(dataSocket)
    const command = path?.trim() ? `LIST ${path}` : 'LIST'
    const commandPromise = this.control.command(command, { timeoutMs: FTP_TIMEOUT.transfer })
    try {
      // Observe both channels immediately. A data failure retires the control
      // connection before another operation/lease can use uncertain replies.
      const [, data] = await Promise.all([
        commandPromise.then((reply) => {
          if (reply.code !== 226 && reply.code !== 250) {
            this.dataConnection.close()
            throw new Error(`LIST thất bại: ${reply.code} ${reply.message}`)
          }
        }),
        dataPromise.catch((error: unknown) => { this.disconnect(); throw error })
      ])
      return data.toString('utf8')
    } catch (error) {
      this.dataConnection.close()
      await Promise.allSettled([commandPromise, dataPromise])
      throw error
    } finally {
      this.dataConnection.close()
    }
  }

  async pwd(): Promise<string> {
    return this.runOperation(() => this.pwdOperation())
  }

  private async pwdOperation(): Promise<string> {
    this.ensureAuthenticated()
    const reply = await this.control.command('PWD')
    if (reply.code !== 257) {
      throw new Error(`PWD thất bại: ${reply.code} ${reply.message}`)
    }
    const match = reply.message.match(/^"((?:[^"]|"")*)"/)
    if (!match) {
      throw new Error(`Không parse được PWD reply: ${reply.message}`)
    }
    return match[1].replace(/""/g, '"')
  }

  async cwd(path: string): Promise<void> {
    return this.runOperation(() => this.cwdOperation(path))
  }

  private async cwdOperation(path: string): Promise<void> {
    this.ensureAuthenticated()
    if (!path.trim()) {
      throw new Error('Path không được để trống')
    }
    const reply = await this.control.command(`CWD ${path}`)
    if (reply.code !== 250) {
      throw new Error(`CWD thất bại: ${reply.code} ${reply.message}`)
    }
  }

  async cdup(): Promise<void> {
    return this.runOperation(() => this.cdupOperation())
  }

  private async cdupOperation(): Promise<void> {
    this.ensureAuthenticated()
    const reply = await this.control.command('CDUP')
    if (reply.code !== 200 && reply.code !== 250) {
      throw new Error(`CDUP thất bại: ${reply.code} ${reply.message}`)
    }
  }

  async system(): Promise<string> {
    return this.runOperation(() => this.systemOperation())
  }

  private async systemOperation(): Promise<string> {
    this.ensureAuthenticated()
    const reply = await this.control.command('SYST')
    if (reply.code !== 215) {
      throw new Error(`SYST thất bại: ${reply.code} ${reply.message}`)
    }
    return reply.message
  }

  async noop(): Promise<void> {
    return this.runOperation(() => this.noopOperation())
  }

  private async noopOperation(): Promise<void> {
    this.ensureAuthenticated()
    const reply = await this.control.command('NOOP')
    if (reply.code !== 200) {
      throw new Error(`NOOP thất bại: ${reply.code} ${reply.message}`)
    }
  }

  async mkd(path: string): Promise<void> {
    return this.runOperation(() => this.mkdOperation(path))
  }

  private async mkdOperation(path: string): Promise<void> {
    this.ensureAuthenticated()
    if (!path.trim()) {
      throw new Error('Path không được để trống')
    }
    const reply = await this.control.command(`MKD ${path}`)
    if (reply.code !== 257) {
      throw new Error(`MKD thất bại: ${reply.code} ${reply.message}`)
    }
  }

  async rmd(path: string): Promise<void> {
    return this.runOperation(() => this.rmdOperation(path))
  }

  private async rmdOperation(path: string): Promise<void> {
    this.ensureAuthenticated()
    if (!path.trim()) {
      throw new Error('Path không được để trống')
    }
    const reply = await this.control.command(`RMD ${path}`)
    if (reply.code !== 250) {
      throw new Error(`RMD thất bại: ${reply.code} ${reply.message}`)
    }
  }

  async deleteDirectory(path: string): Promise<void> {
    return this.runOperation(() => this.deleteDirectoryOperation(path))
  }

  private async deleteDirectoryOperation(path: string): Promise<void> {
    this.ensureAuthenticated()
    if (!path.trim()) {
      throw new Error('Path không được để trống')
    }
    const workingDirectory = posix.isAbsolute(path) ? '/' : await this.pwd()
    if (!posix.isAbsolute(workingDirectory)) {
      throw new Error('PWD không trả về đường dẫn tuyệt đối')
    }
    const directory = posix.resolve(workingDirectory, path)
    if (directory === '/') {
      throw new Error('Không thể xóa thư mục gốc')
    }

    const entries = await this.list(directory)
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue

      const childPath = `${directory.replace(/\/$/, '')}/${entry.name}`
      if (entry.type === 'directory') {
        await this.deleteDirectory(childPath)
      } else {
        await this.dele(childPath)
      }
    }

    await this.rmd(directory)
  }

  async dele(path: string): Promise<void> {
    return this.runOperation(() => this.deleOperation(path))
  }

  private async deleOperation(path: string): Promise<void> {
    this.ensureAuthenticated()
    if (!path.trim()) {
      throw new Error('Path không được để trống')
    }
    const reply = await this.control.command(`DELE ${path}`)
    if (reply.code !== 250) {
      throw new Error(`DELE thất bại: ${reply.code} ${reply.message}`)
    }
  }

  async rename(from: string, to: string): Promise<void> {
    return this.runOperation(() => this.renameOperation(from, to))
  }

  private async renameOperation(from: string, to: string): Promise<void> {
    this.ensureAuthenticated()
    if (!from.trim()) {
      throw new Error('Source path không được để trống')
    }
    if (!to.trim()) {
      throw new Error('Destination path không được để trống')
    }
    const fromReply = await this.control.command(`RNFR ${from}`)
    if (fromReply.code !== 350) {
      throw new Error(`RNFR thất bại: ${fromReply.code} ${fromReply.message}`)
    }
    const toReply = await this.control.command(`RNTO ${to}`)
    if (toReply.code !== 250) {
      throw new Error(`RNTO thất bại: ${toReply.code} ${toReply.message}`)
    }
  }

  async quit(): Promise<void> {
    return this.runOperation(() => this.quitOperation())
  }

  private async quitOperation(): Promise<void> {
    if (this.state === 'disconnected') {
      return
    }
    try {
      const reply = await this.control.command('QUIT')
      if (reply.code !== 221) {
        throw new Error(`QUIT thất bại: ${reply.code} ${reply.message}`)
      }
    } finally {
      this.dataConnection.close()
      this.control.close()
      this.state = 'disconnected'
    }
  }

  private ensureAuthenticated(): void {
    if (this.state !== 'authenticated') {
      throw new Error('FTP client chưa đăng nhập')
    }
  }

  private cancelActiveTransfer(): void {
    this.dataConnection.close()
    void this.control.abortTransfer().catch(() => undefined)
  }

  async pasv(): Promise<PassiveAddress> {
    return this.runOperation(() => this.pasvOperation())
  }

  private async pasvOperation(): Promise<PassiveAddress> {
    this.ensureAuthenticated()
    const reply = await this.control.command('PASV')
    if (reply.code !== 227) {
      throw new Error(`PASV thất bại: ${reply.code} ${reply.message}`)
    }
    return parsePasvReply(reply)
  }

  private async openPassiveDataConnection(): Promise<net.Socket> {
    const address = await this.pasv()
    return this.dataConnection.connect({
      host: address.host,
      port: address.port
    })
  }

  private readDataSocket(socket: net.Socket): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let settled = false
      const finish = () => {
        if (settled) {
          return
        }
        settled = true
        resolve(Buffer.concat(chunks))
      }
      socket.on('data', (chunk: Buffer) => {
        chunks.push(chunk)
      })
      socket.once('end', finish)
      socket.once('close', finish)
      socket.once('error', (error) => {
        if (settled) {
          return
        }
        settled = true
        reject(error)
      })
    })
  }

  private async setBinaryType(): Promise<void> {
    this.ensureAuthenticated()
    const reply = await this.control.command('TYPE I')
    if (reply.code !== 200) {
      throw new Error(`TYPE I thất bại: ${reply.code} ${reply.message}`)
    }
  }

  private createProgressStream(
    totalBytes: number | null,
    onProgress?: (progress: TransferProgress) => void
  ): Transform {
    let transferredBytes = 0
    let lastReportedAt = 0

    onProgress?.({ transferredBytes, totalBytes })

    return new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        transferredBytes += chunk.length
        const now = Date.now()

        if (now - lastReportedAt >= 100) {
          lastReportedAt = now
          onProgress?.({ transferredBytes, totalBytes })
        }

        callback(null, chunk)
      },
      flush(callback) {
        onProgress?.({ transferredBytes, totalBytes })
        callback()
      }
    })
  }
}
