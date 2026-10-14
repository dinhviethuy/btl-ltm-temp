import type { FtpReply, PassiveAddress } from './types'

export function parsePasvReply(reply: FtpReply): PassiveAddress {
  if (reply.code !== 227) {
    throw new Error(`PASV reply không hợp lệ: ${reply.code} ${reply.message}`)
  }
  const match = reply.message.match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/)
  if (!match) {
    throw new Error(`Không parse được PASV reply: ${reply.message}`)
  }
  const numbers = match.slice(1).map(Number)
  if (numbers.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    throw new Error(`PASV address không hợp lệ: ${reply.message}`)
  }
  const [h1, h2, h3, h4, p1, p2] = numbers
  const host = `${h1}.${h2}.${h3}.${h4}`
  const port = p1 * 256 + p2
  if (port <= 0 || port > 65535) {
    throw new Error(`PASV port không hợp lệ: ${port}`)
  }

  return {
    host,
    port
  }
}
