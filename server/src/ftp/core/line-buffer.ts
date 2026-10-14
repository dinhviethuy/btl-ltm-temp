import { StringDecoder } from 'node:string_decoder'

export class LineBuffer {
  private buffer = ''
  private readonly decoder = new StringDecoder('utf8')

  push(chunk: Buffer): string[] {
    this.buffer += this.decoder.write(chunk)
    const parts = this.buffer.split(`\r\n`)
    this.buffer = parts.pop() ?? ''
    return parts
  }
}
