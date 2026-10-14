import type { FtpReply } from './types'

export type QueuedCommand = {
  command: string
  resolve: (reply: FtpReply) => void
  reject: (error: Error) => void
  onPreliminary?: (reply: FtpReply) => void
  timeoutMs: number
  timeout?: NodeJS.Timeout
}

export class CommandQueue {
  private readonly commands: QueuedCommand[] = []

  push(command: QueuedCommand): void {
    this.commands.push(command)
  }

  shift(): QueuedCommand | undefined {
    return this.commands.shift()
  }

  removeFirst(predicate: (command: QueuedCommand) => boolean): QueuedCommand | undefined {
    const index = this.commands.findIndex(predicate)
    if (index < 0) return undefined
    return this.commands.splice(index, 1)[0]
  }

  drain(): QueuedCommand[] {
    return this.commands.splice(0)
  }
}
