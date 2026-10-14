import { parsePasvReply } from './passive'
import type { FtpReply } from './types'

const reply = (code: number, message: string): FtpReply => ({ code, message, lines: [`${code} ${message}`] })

describe('PASV parser', () => {
  it('parses host and port', () => {
    expect(parsePasvReply(reply(227, 'Entering Passive Mode (127,0,0,1,195,80)'))).toEqual({ host: '127.0.0.1', port: 50000 })
    expect(parsePasvReply(reply(227, 'Entering Passive Mode (192,168,1,10,4,20)'))).toEqual({ host: '192.168.1.10', port: 1044 })
  })

  it.each([reply(500, 'Failed'), reply(227, 'Malformed'), reply(227, '(127,0,0,300,1,2)'), reply(227, '(127,0,0,1,0,0)')])('rejects invalid reply %#', (invalid) => {
    expect(() => parsePasvReply(invalid)).toThrow()
  })
})
