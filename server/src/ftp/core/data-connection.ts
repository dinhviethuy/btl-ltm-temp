import net from 'node:net'

import { FTP_TIMEOUT } from './constants'

export interface DataConnectionOptions {
  connectTimeoutMs?: number
  idleTimeoutMs?: number
}

export class DataConnection {
  private socket: net.Socket | null = null

  connect(
    {
      host,
      port
    }: {
      host: string
      port: number
    },
    options: DataConnectionOptions = {}
  ): Promise<net.Socket> {
    if (this.socket && !this.socket.destroyed) {
      return Promise.reject(new Error('Data connection đang tồn tại'))
    }

    const connectTimeoutMs = options.connectTimeoutMs ?? FTP_TIMEOUT.dataConnect

    const idleTimeoutMs = options.idleTimeoutMs ?? FTP_TIMEOUT.dataIdle

    const socket = new net.Socket()

    /*
     * Set ngay từ lúc bắt đầu connect,
     * tránh gọi connect() lần hai khi
     * socket đầu vẫn đang connecting.
     */
    this.socket = socket

    return new Promise<net.Socket>((resolve, reject) => {
      let settled = false

      let connectTimer: NodeJS.Timeout | undefined

      const clearConnectTimer = () => {
        if (!connectTimer) {
          return
        }

        clearTimeout(connectTimer)

        connectTimer = undefined
      }

      const onConnect = () => {
        if (settled) {
          return
        }

        settled = true

        clearConnectTimer()

        /*
         * Connect thành công.
         *
         * Bắt đầu theo dõi idle time.
         */
        if (idleTimeoutMs > 0) {
          socket.setTimeout(idleTimeoutMs)
        }

        resolve(socket)
      }

      const onError = (error: Error) => {
        /*
         * Nếu lỗi xảy ra khi đang
         * CONNECT thì reject connect().
         */
        if (!settled) {
          settled = true

          clearConnectTimer()

          if (this.socket === socket) {
            this.socket = null
          }

          reject(error)

          return
        }

        /*
         * Nếu đã connect thì không còn
         * Promise connect() để reject.
         *
         * Listener này vẫn được giữ để
         * socket error không biến thành
         * unhandled error.
         *
         * pipeline()/caller cũng có thể
         * attach error listener riêng.
         */
      }

      const onTimeout = () => {
        /*
         * setTimeout của net.Socket là
         * IDLE timeout.
         *
         * Nó chỉ emit "timeout",
         * không tự đóng socket.
         */
        socket.destroy(new Error(`FTP data connection idle timeout: ${idleTimeoutMs}ms`))
      }

      const onClose = () => {
        clearConnectTimer()

        socket.setTimeout(0)

        socket.off('timeout', onTimeout)

        if (this.socket === socket) {
          this.socket = null
        }

        /*
         * Socket bị đóng trước khi
         * connect thành công.
         */
        if (!settled) {
          settled = true

          reject(new Error('FTP data connection đã đóng trước khi kết nối thành công'))
        }
      }

      socket.once('connect', onConnect)

      /*
       * Giữ listener này cả sau khi
       * connect để tránh unhandled
       * socket error.
       */
      socket.once('error', onError)

      socket.once('close', onClose)

      socket.on('timeout', onTimeout)

      /*
       * Đây là TCP CONNECT timeout.
       *
       * Khác với idle timeout ở trên.
       */
      connectTimer = setTimeout(() => {
        if (settled) {
          return
        }

        settled = true

        const error = new Error(`FTP data connection timeout: ${host}:${port}`)

        clearConnectTimer()

        if (this.socket === socket) {
          this.socket = null
        }

        socket.destroy()

        reject(error)
      }, connectTimeoutMs)

      try {
        socket.connect(port, host)
      } catch (error) {
        if (settled) {
          return
        }

        settled = true

        clearConnectTimer()

        if (this.socket === socket) {
          this.socket = null
        }

        socket.destroy()

        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  close(): void {
    const socket = this.socket

    this.socket = null

    if (!socket) {
      return
    }

    /*
     * Tắt idle timer.
     */
    socket.setTimeout(0)

    if (!socket.destroyed) {
      socket.destroy()
    }
  }
}
