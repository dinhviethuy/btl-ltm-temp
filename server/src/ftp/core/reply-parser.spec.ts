import { ReplyParser } from './reply-parser'

describe('ReplyParser', () => {
  it('parses a single-line reply', () => {
    expect(new ReplyParser().push('331 Password required')).toEqual({ code: 331, message: 'Password required', lines: ['331 Password required'] })
    expect(new ReplyParser().push('530 Login incorrect')).toEqual({ code: 530, message: 'Login incorrect', lines: ['530 Login incorrect'] })
  })

  it('waits for the matching multiline terminator and resets', () => {
    const parser = new ReplyParser()
    expect(parser.push('211-Features:')).toBeNull()
    expect(parser.push('123 hello')).toBeNull()
    expect(parser.push('')).toBeNull()
    expect(parser.push('211 End')).toEqual({ code: 211, message: 'End', lines: ['211-Features:', '123 hello', '', '211 End'] })
    expect(parser.push('220 Ready')?.code).toBe(220)
  })

  it('accepts unrelated numeric lines inside a multiline reply', () => {
    const parser = new ReplyParser()
    expect(parser.push('220-Start')).toBeNull()
    expect(parser.push('123 Still inside')).toBeNull()
    expect(parser.push('220 End')).toEqual({ code: 220, message: 'End', lines: ['220-Start', '123 Still inside', '220 End'] })
  })

  it.each(['Hello world', '22 Ready', '2200 Ready'])('rejects malformed reply %s', (line) => {
    expect(() => new ReplyParser().push(line)).toThrow()
  })
})
