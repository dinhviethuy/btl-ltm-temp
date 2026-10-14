import { ControlConnection } from './control-connection'
import { startControlServer } from '../../../test/ftp-test-server'

describe('FTP command queue', () => {
  it('keeps concurrent command replies in request order', async () => {
    const server = await startControlServer((command, socket) => {
      socket.write(`${command === 'SYST' ? 215 : command === 'PWD' ? 257 : 200} ${command}\r\n`)
    })
    const control = new ControlConnection()
    try {
      await control.connect({ host: '127.0.0.1', port: server.port })
      const replies = await Promise.all([control.command('SYST'), control.command('PWD'), control.command('NOOP')])
      expect(replies.map((reply) => reply.code)).toEqual([215, 257, 200])
      expect(server.commands).toEqual(['SYST', 'PWD', 'NOOP'])
      const batch = await Promise.all(Array.from({ length: 20 }, () => control.command('NOOP')))
      expect(batch.map((reply) => reply.code)).toEqual(Array(20).fill(200))
      expect((await control.command('PWD')).code).toBe(257)
    } finally {
      control.close()
      await server.close()
    }
  })
})
