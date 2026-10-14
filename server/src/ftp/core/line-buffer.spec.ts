import { LineBuffer } from './line-buffer'

describe('LineBuffer', () => {
  it('reassembles a reply at every byte boundary', () => {
    const message = '220 FTP Server Ready\r\n'
    for (let split = 1; split < message.length; split++) {
      const buffer = new LineBuffer()
      expect([...buffer.push(Buffer.from(message.slice(0, split))), ...buffer.push(Buffer.from(message.slice(split)))]).toEqual(['220 FTP Server Ready'])
    }
  })

  it('preserves empty lines and incomplete UTF-8 characters', () => {
    const bytes = Buffer.from('220 Máy chủ\r\n\r\n230 Logged in\r\n')
    const buffer = new LineBuffer()
    const lines: string[] = []
    for (const byte of bytes) lines.push(...buffer.push(Buffer.from([byte])))
    expect(lines).toEqual(['220 Máy chủ', '', '230 Logged in'])
  })

  it('keeps a trailing partial line across pushes', () => {
    const buffer = new LineBuffer()
    expect(buffer.push(Buffer.from('220 Ready\r\n331 Pass'))).toEqual(['220 Ready'])
    expect(buffer.push(Buffer.alloc(0))).toEqual([])
    expect(buffer.push(Buffer.from('word required\r'))).toEqual([])
    expect(buffer.push(Buffer.from('\n'))).toEqual(['331 Password required'])
  })

  it('returns the same thousand lines for many chunk sizes', () => {
    const expected = Array.from({ length: 1000 }, (_, i) => `200 Reply ${i}`)
    const bytes = Buffer.from(expected.join('\r\n') + '\r\n')
    for (const chunkSize of [1, 2, 7, 17, 32, bytes.length]) {
      const buffer = new LineBuffer()
      const actual: string[] = []
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        actual.push(...buffer.push(bytes.subarray(offset, offset + chunkSize)))
      }
      expect(actual).toEqual(expected)
    }
  })
})
