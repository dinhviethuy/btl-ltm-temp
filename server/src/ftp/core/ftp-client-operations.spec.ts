import { posix } from 'node:path'
import { Readable } from 'node:stream'
import { startControlServer, startTransferServer } from '../../../test/ftp-test-server'
import { FtpSessionService } from '../ftp-session.service'
import { FtpService } from '../ftp.service'
import { FtpClient } from './ftp-client'

describe('FTP operation ordering', () => {
  it('holds TYPE/PASV/STOR through completion before starting the next data operation', async () => {
    const server = await startTransferServer()
    const client = new FtpClient()
    try {
      await client.connect(`ftp://127.0.0.1:${server.port}`)
      await client.login({ username: 'demo', password: 'secret' })
      const uploads = await Promise.allSettled([
        client.uploadStream({ remotePath: '/first', stream: Readable.from(['first']) }),
        client.uploadStream({ remotePath: '/second', stream: Readable.from(['second']) })
      ])
      expect(uploads).toEqual([{ status: 'fulfilled', value: undefined }, { status: 'fulfilled', value: undefined }])
      expect(server.commands.slice(2)).toEqual(['TYPE I', 'PASV', 'STOR /first', 'TYPE I', 'PASV', 'STOR /second'])
      expect(Buffer.concat(server.uploads).toString()).toBe('firstsecond')
    } finally { client.disconnect(); await server.close() }
  })

  it('renames each source to its own destination without another operation interrupting RNFR/RNTO', async () => {
    const entries = new Map([['/A', 'contents A'], ['/B', 'contents B']])
    let source = ''
    const server = await startControlServer((command, socket) => {
      if (command.startsWith('USER ')) socket.write('230 Logged in\r\n')
      else if (command.startsWith('RNFR ')) {
        source = command.slice(5)
        socket.write('350 Ready for destination\r\n')
      } else if (command.startsWith('RNTO ')) {
        if (!entries.has(source)) { socket.write('503 RNFR required\r\n'); return }
        entries.set(command.slice(5), entries.get(source)!)
        entries.delete(source)
        source = ''
        socket.write('250 Renamed\r\n')
      } else if (command === 'PWD') {
        // A server can cancel rename state on an intervening command.
        source = ''
        socket.write('257 "/"\r\n')
      }
    })
    const client = new FtpClient()
    try {
      await client.connect(`ftp://127.0.0.1:${server.port}`)
      await client.login({ username: 'demo' })
      const results = await Promise.allSettled([client.rename('/A', '/A-new'), client.rename('/B', '/B-new'), client.pwd()])
      expect(results).toEqual([{ status: 'fulfilled', value: undefined }, { status: 'fulfilled', value: undefined }, { status: 'fulfilled', value: '/' }])
      expect(server.commands).toEqual(['USER demo', 'RNFR /A', 'RNTO /A-new', 'RNFR /B', 'RNTO /B-new', 'PWD'])
      expect([...entries]).toEqual([['/A-new', 'contents A'], ['/B-new', 'contents B']])
    } finally { client.disconnect(); await server.close() }
  })

  it('keeps each USER/PASS pair together and runs the next login after a rejected operation', async () => {
    let username = ''
    const server = await startControlServer((command, socket) => {
      if (command.startsWith('USER ')) { username = command.slice(5); socket.write('331 Password required\r\n') }
      else if (command.startsWith('PASS ')) {
        socket.write(username === 'bob' && command === 'PASS secret' ? '230 Logged in\r\n' : '530 Invalid credentials\r\n')
      }
    })
    const client = new FtpClient()
    try {
      await client.connect(`ftp://127.0.0.1:${server.port}`)
      const results = await Promise.allSettled([
        client.login({ username: 'alice', password: 'wrong' }),
        client.login({ username: 'bob', password: 'secret' })
      ])
      expect(results[0]).toMatchObject({ status: 'rejected' })
      expect(results[1]).toMatchObject({ status: 'fulfilled', value: { code: 230 } })
      expect(server.commands).toEqual(['USER alice', 'PASS wrong', 'USER bob', 'PASS secret'])
      expect(client.getState()).toBe('authenticated')
    } finally { client.disconnect(); await server.close() }
  })

  it.each(['cwd', 'cdup'] as const)('returns the directory from its own %s/PWD sequence', async (navigation) => {
    let directory = '/home/child'
    const server = await startControlServer((command, socket) => {
      if (command.startsWith('USER ')) socket.write('230 Logged in\r\n')
      else if (command.startsWith('CWD ')) { directory = command.slice(4); socket.write('250 Directory changed\r\n') }
      else if (command === 'CDUP') { directory = posix.dirname(directory); socket.write('250 Parent selected\r\n') }
      else if (command === 'PWD') socket.write(`257 "${directory}"\r\n`)
    })
    const sessions = new FtpSessionService(() => new FtpClient())
    const files = new FtpService(sessions)
    try {
      const { sessionId } = await sessions.create({ host: '127.0.0.1', port: server.port })
      await sessions.login(sessionId, { username: 'demo', password: '' })
      const first = navigation === 'cwd' ? files.cwd(sessionId, '/A') : files.cdup(sessionId)
      expect(await Promise.all([first, files.cwd(sessionId, '/B')])).toEqual([navigation === 'cwd' ? '/A' : '/home', '/B'])
      expect(server.commands).toEqual(['USER demo', navigation === 'cwd' ? 'CWD /A' : 'CDUP', 'PWD', 'CWD /B', 'PWD'])
    } finally { sessions.onModuleDestroy(); await server.close() }
  })
})
