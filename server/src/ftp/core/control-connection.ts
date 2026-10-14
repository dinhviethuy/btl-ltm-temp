import net from 'node:net'

import { FTP_TIMEOUT } from './constants'
import { CommandQueue, type QueuedCommand } from './command-queue'
import { LineBuffer } from './line-buffer'
import { ReplyParser } from './reply-parser'

import type { FtpReply } from './types'

export type CommandOptions = {
  onPreliminary?: (reply: FtpReply) => void
  timeoutMs?: number
}

type PendingReply = {
  resolve: (reply: FtpReply) => void
  reject: (error: Error) => void

  timeout?: NodeJS.Timeout
}

type PendingAbort = {
  resolve: () => void
  reject: (error: Error) => void
  probeSent: boolean
  timeout?: NodeJS.Timeout
}

export class ControlConnection {
  private socket: net.Socket | null = null

  private lineBuffer = new LineBuffer()

  private replyParser = new ReplyParser()

  private commandQueue = new CommandQueue()

  private activeCommand: QueuedCommand | null = null

  private greetingPending: PendingReply | null = null

  private abortPending: PendingAbort | null = null

  private readonly commandTimeoutMs = FTP_TIMEOUT.command

  private readonly connectTimeoutMs = FTP_TIMEOUT.connect

  private readonly onDisconnected?: (error: Error) => void

  constructor(onDisconnected?: (error: Error) => void) {
    this.onDisconnected = onDisconnected
  }

  async connect({ host, port }: { host: string; port: number }): Promise<FtpReply> {
    if (this.socket && !this.socket.destroyed) {
      throw new Error('Control connection đã tồn tại')
    }

    /*
     * Connection mới → parser/state mới.
     */
    this.lineBuffer = new LineBuffer()

    this.replyParser = new ReplyParser()

    this.commandQueue = new CommandQueue()
    this.activeCommand = null
    this.greetingPending = null
    this.abortPending = null

    const socket = new net.Socket()

    this.socket = socket

    this.bindSocketEvents(socket)

    const greetingPromise = new Promise<FtpReply>((resolve, reject) => {
      const pending: PendingReply = {
        resolve,
        reject
      }

      pending.timeout = setTimeout(() => {
        /*
         * Chỉ timeout nếu greeting
         * này vẫn đang pending.
         */
        if (this.greetingPending !== pending) {
          return
        }

        const error = new Error(`FTP connect timeout: ${host}:${port}`)

        this.close(error)
      }, this.connectTimeoutMs)

      this.greetingPending = pending
    })

    try {
      socket.connect(port, host)
    } catch (error) {
      const normalized = this.normalizeError(error)

      this.close(normalized)
    }

    return greetingPromise
  }

  command(command: string, options: CommandOptions = {}): Promise<FtpReply> {
    if (/[\r\n]/.test(command)) {
      return Promise.reject(new Error('FTP command cannot contain CR or LF'))
    }
    if (!this.socket || this.socket.destroyed) {
      return Promise.reject(new Error('Chưa kết nối FTP server'))
    }

    return new Promise<FtpReply>((resolve, reject) => {
      this.commandQueue.push({
        command,

        resolve,
        reject,

        onPreliminary: options.onPreliminary,

        timeoutMs: options.timeoutMs ?? this.commandTimeoutMs
      })

      this.processQueue()
    })
  }

  /**
   * Session reuse requires an ordered server: every transfer/ABOR reply must
   * precede the internal NOOP's 200. RFC 959 sections 4.1.3, 4.2 and 5.4 describe
   * the ABOR exchange, queuing of early commands, and command/reply sequencing:
   * https://www.rfc-editor.org/rfc/rfc959.html
   *
   * Probing after the first final reply accommodates one- and two-final-reply
   * servers; it relies on that queuing behavior, not a universal wire barrier.
   * FTP has no reply IDs: if a server lets 200 overtake an ABOR 226, a later 226
   * can be indistinguishable from a subsequent transfer's legitimate completion.
   * Detectable ordering violations close the connection; no delay can make
   * arbitrary reordering safe while retaining the session.
   */
  abortTransfer(): Promise<void> {
    if (!this.socket || this.socket.destroyed) {
      return Promise.reject(new Error('Chưa kết nối FTP server'))
    }
    if (this.abortPending) {
      return Promise.reject(new Error('FTP transfer abort đang chờ reply'))
    }

    const isTransfer = (command: QueuedCommand) => /^(?:RETR|STOR|LIST)(?:\s|$)/i.test(command.command)
    const active = this.activeCommand
    if (active && !isTransfer(active)) {
      const queued = this.commandQueue.removeFirst(isTransfer)
      queued?.reject(new Error('FTP transfer aborted'))
      return Promise.resolve()
    }
    if (!active) {
      const queued = this.commandQueue.removeFirst(isTransfer)
      if (queued) {
        queued.reject(new Error('FTP transfer aborted'))
        return Promise.resolve()
      }
    }

    if (active) {
      this.activeCommand = null
      if (active.timeout) clearTimeout(active.timeout)
      active.reject(new Error('FTP transfer aborted'))
    }

    const abortPromise = new Promise<void>((resolve, reject) => {
      const pending: PendingAbort = { resolve, reject, probeSent: false }
      pending.timeout = setTimeout(() => {
        if (this.abortPending === pending) {
          this.close(new Error('FTP ABOR timeout'))
        }
      }, this.commandTimeoutMs)
      this.abortPending = pending
    })

    try {
      this.socket.write('ABOR\r\n')
    } catch (error) {
      this.close(this.normalizeError(error))
    }
    return abortPromise
  }

  close(reason = new Error('FTP control connection đã đóng')): void {
    const socket = this.socket

    /*
     * Cleanup Promise/state trước.
     */
    this.handleDisconnect(reason, socket)

    /*
     * destroy() dùng để đóng ngay.
     *
     * QUIT graceful đã được gửi
     * trước khi FtpClient gọi close().
     */
    if (socket && !socket.destroyed) {
      socket.destroy()
    }
  }

  private processQueue(): void {
    if (!this.socket || this.socket.destroyed || this.activeCommand || this.abortPending) {
      return
    }

    const next = this.commandQueue.shift()

    if (!next) {
      return
    }

    this.activeCommand = next

    /*
     * Timeout bắt đầu ở đây,
     * không phải lúc enqueue.
     */
    next.timeout = setTimeout(() => {
      if (this.activeCommand !== next) {
        return
      }

      const error = new Error(`FTP command timeout: ${next.command}`)

      /*
       * Không tiếp tục dùng connection
       * sau command timeout.
       *
       * Reply trễ có thể làm protocol
       * mất đồng bộ.
       */
      this.close(error)
    }, next.timeoutMs)

    console.log(`> ${this.formatCommandForLog(next.command)}`)

    try {
      this.socket.write(`${next.command}\r\n`)
    } catch (error) {
      this.close(this.normalizeError(error))
    }
  }

  private handleReply(reply: FtpReply): void {
    if (this.abortPending) {
      if (this.isPreliminaryReply(reply)) return
      const pending = this.abortPending
      if (!pending.probeSent) {
        if (reply.code !== 225 && reply.code !== 226 && reply.code !== 426) {
          this.close(new Error(`FTP ABOR thất bại: ${reply.code} ${reply.message}`))
          return
        }
        pending.probeSent = true
        try {
          // Only an ordered server makes this a barrier; see abortTransfer's contract.
          this.socket?.write('NOOP\r\n')
        } catch (error) {
          this.close(this.normalizeError(error))
        }
        return
      }
      if (reply.code === 225 || reply.code === 226 || reply.code === 426) return
      this.abortPending = null
      if (pending.timeout) clearTimeout(pending.timeout)
      if (reply.code === 200) {
        pending.resolve()
        this.processQueue()
      } else {
        const error = new Error(`FTP ABOR thất bại: ${reply.code} ${reply.message}`)
        pending.reject(error)
        this.close(error)
      }
      return
    }
    /*
     * Greeting.
     */
    if (this.greetingPending) {
      /*
       * RFC có thể trả 120 trước
       * rồi mới 220.
       */
      if (this.isPreliminaryReply(reply)) {
        return
      }

      const pending = this.greetingPending

      this.greetingPending = null

      if (pending.timeout) {
        clearTimeout(pending.timeout)
      }

      pending.resolve(reply)

      return
    }

    // These replies cannot belong to our known non-transfer commands (or an
    // idle connection). Fail closed instead of shifting queued replies. Leave
    // unknown verbs alone: command() also permits extensions such as MLSD.
    if (
      (reply.code === 225 || reply.code === 226 || reply.code === 426) &&
      (!this.activeCommand ||
        /^(?:USER|PASS|PWD|CWD|CDUP|SYST|NOOP|MKD|RMD|DELE|RNFR|RNTO|QUIT|PASV|TYPE)(?:\s|$)/i.test(this.activeCommand.command))
    ) {
      this.close(new Error(`FTP control reply out of sequence: ${reply.code}`))
      return
    }

    /*
     * Command đang chạy.
     */
    if (this.activeCommand) {
      /*
       * LIST / RETR / STOR:
       *
       * 150
       *
       * Không resolve command.
       */
      if (this.isPreliminaryReply(reply)) {
        try {
          this.activeCommand.onPreliminary?.(reply)
        } catch (error) {
          this.close(this.normalizeError(error))
        }

        return
      }

      const current = this.activeCommand

      this.activeCommand = null

      if (current.timeout) {
        clearTimeout(current.timeout)
      }

      current.resolve(reply)

      /*
       * Final reply xong rồi mới
       * gửi command tiếp theo.
       */
      this.processQueue()

      return
    }

    console.warn('Unexpected FTP reply:', reply)
  }

  private bindSocketEvents(socket: net.Socket): void {
    socket.on('connect', () => {
      /*
       * Nếu đây là socket cũ thì
       * không cần xử lý.
       */
      if (this.socket !== socket) {
        return
      }

      console.log('TCP connected')
    })

    socket.on('data', (chunk: Buffer) => {
      if (this.socket !== socket) {
        return
      }

      this.handleData(chunk)
    })

    socket.on('error', (error) => {
      this.handleDisconnect(error, socket)
    })

    socket.on('close', () => {
      this.handleDisconnect(new Error('FTP control connection đã đóng'), socket)
    })
  }

  private handleData(chunk: Buffer): void {
    try {
      const lines = this.lineBuffer.push(chunk)

      for (const line of lines) {
        console.log(`< ${line}`)

        const reply = this.replyParser.push(line)

        if (reply) {
          this.handleReply(reply)
          // A protocol failure also invalidates the remaining replies in this chunk.
          if (!this.socket) return
        }
      }
    } catch (error) {
      /*
       * Reply malformed → protocol
       * không còn đáng tin cậy.
       */
      this.close(this.normalizeError(error))
    }
  }

  private handleDisconnect(error: Error, socket: net.Socket | null): void {
    /*
     * Nếu event thuộc socket cũ,
     * bỏ qua.
     *
     * Quan trọng khi reconnect.
     */
    if (socket && this.socket !== socket) {
      return
    }

    /*
     * Nếu đã cleanup rồi thì
     * error + close event thứ hai
     * không làm gì nữa.
     */
    if (socket && this.socket === null) {
      return
    }

    this.rejectPending(error)

    this.socket = null

    this.onDisconnected?.(error)
  }

  private rejectPending(error: Error): void {
    if (this.abortPending) {
      const pending = this.abortPending
      this.abortPending = null
      if (pending.timeout) clearTimeout(pending.timeout)
      pending.reject(error)
    }
    /*
     * Greeting.
     */
    if (this.greetingPending) {
      const pending = this.greetingPending

      this.greetingPending = null

      if (pending.timeout) {
        clearTimeout(pending.timeout)
      }

      pending.reject(error)
    }

    /*
     * Active command.
     */
    if (this.activeCommand) {
      const active = this.activeCommand

      this.activeCommand = null

      if (active.timeout) {
        clearTimeout(active.timeout)
      }

      active.reject(error)
    }

    /*
     * Commands vẫn đang đợi
     * trong queue.
     */
    for (const command of this.commandQueue.drain()) {
      if (command.timeout) {
        clearTimeout(command.timeout)
      }

      command.reject(error)
    }

    this.commandQueue = new CommandQueue()
  }

  private formatCommandForLog(command: string): string {
    if (command.toUpperCase().startsWith('PASS ')) {
      return 'PASS ******'
    }

    return command
  }

  private isPreliminaryReply(reply: FtpReply): boolean {
    return reply.code >= 100 && reply.code < 200
  }

  private normalizeError(error: unknown): Error {
    if (error instanceof Error) {
      return error
    }

    return new Error(String(error))
  }
}
