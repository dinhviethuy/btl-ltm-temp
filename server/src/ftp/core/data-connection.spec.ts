import * as net from 'node:net'
import { DataConnection } from './data-connection'

describe('DataConnection', () => {
  it('opens and closes a passive data socket', async () => {
    const accepted = new Set<net.Socket>()
    const server = net.createServer((socket) => { accepted.add(socket); socket.on('close', () => accepted.delete(socket)) })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port
    const connection = new DataConnection()
    try {
      const socket = await connection.connect({ host: '127.0.0.1', port })
      expect(socket.destroyed).toBe(false)
      expect(socket.remotePort).toBe(port)
      connection.close()
      expect(socket.destroyed).toBe(true)
      const second = await connection.connect({ host: '127.0.0.1', port })
      expect(second.destroyed).toBe(false)
      expect(second).not.toBe(socket)
    } finally {
      connection.close()
      for (const socket of accepted) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
