import { FtpReply } from './types'

export class ReplyParser {
  private multilineCode: number | null = null
  private lines: string[] = []

  push(line: string): FtpReply | null {
    // nếu đang parse multi line
    if (this.multilineCode !== null) {
      this.lines.push(line)
      const endPrefix = `${this.multilineCode} `
      if (line.startsWith(endPrefix)) {
        const reply = this.buildReply()
        this.reset()
        return reply
      }
      return null
    }
    const match = line.match(/^(\d{3})([ -])(.*)$/)

    if (!match) {
      throw new Error(`FTP reply không hợp lệ: ${line}`)
    }
    const code = Number(match[1])
    const separator = match[2]
    // sigle line
    if (separator === ' ') {
      return {
        code,
        message: match[3],
        lines: [line]
      }
    }
    this.multilineCode = code
    this.lines = [line]
    return null
  }

  private buildReply(): FtpReply {
    if (this.multilineCode === null) {
      throw new Error('Không có multiline nào trong quá trình')
    }
    const lastLine = this.lines[this.lines.length - 1]
    return {
      code: this.multilineCode,
      message: lastLine.slice(4),
      lines: this.lines
    }
  }

  private reset(): void {
    this.multilineCode = null
    this.lines = []
  }
}
