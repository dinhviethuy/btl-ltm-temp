import { INestApplication } from '@nestjs/common'
import { WsAdapter } from '@nestjs/platform-ws'
import { Test } from '@nestjs/testing'
import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppModule } from '../src/app.module'
import { startTransferServer } from './ftp-test-server'

type Result = { event: string; code?: string; message?: string }
function mailbox(child: ChildProcess) {
  const events: Result[] = []
  const waiters = new Set<() => void>()
  child.on('message', (message: Result) => { events.push(message); for (const notify of [...waiters]) notify() })
  return (names: string[]) => new Promise<Result>((resolve, reject) => {
    const exited = () => { waiters.delete(check); reject(new Error('Client worker exited before its result')) }
    const check = () => {
      const found = events.find((event) => names.includes(event.event))
      if (found) { waiters.delete(check); child.off('exit', exited); resolve(found) }
    }
    child.once('exit', exited)
    waiters.add(check)
    check()
  })
}

describe('actual Electron-main adapter through HTTP and FTP', () => {
  it.each([
    ['TYPE I', 'upload'], ['PASV', 'upload'], ['TYPE I', 'download'], ['PASV', 'download'],
  ])('cancels a held %s %s, then admits the renderer-queued transfer without a lease conflict', async (command, direction) => {
    const options = command === 'TYPE I' ? { holdType: true } : { holdPasv: true }
    const ftp = await startTransferServer(options)
    const directory = await mkdtemp(join(tmpdir(), 'ftp-client-server-'))
    const localPath = join(directory, 'file.bin')
    await writeFile(localPath, 'next bytes')
    let app: INestApplication | undefined
    let child: ChildProcess | undefined
    try {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
      app = moduleRef.createNestApplication()
      app.setGlobalPrefix('api')
      app.useWebSocketAdapter(new WsAdapter(app))
      await app.listen(0, '127.0.0.1')
      const port = (app.getHttpServer().address() as AddressInfo).port
      child = fork(join(__dirname, 'client-transfer-worker.mjs'), [
        `http://127.0.0.1:${port}/api`, `ftp://127.0.0.1:${ftp.port}`, localPath, direction,
      ], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
      const receive = mailbox(child)
      await receive(['ready'])
      child.send('start')
      await ftp.waitForCommand(command)
      const cancellationReachedServer = new Promise<void>((resolve) => {
        const requested = (request: IncomingMessage) => {
          if (request.method !== 'DELETE' || request.url !== '/api/ftp/transfers/worker-first') return
          app!.getHttpServer().off('request', requested)
          resolve()
        }
        app!.getHttpServer().on('request', requested)
      })
      child.send('cancel')
      await cancellationReachedServer
      options.holdType = false
      options.holdPasv = false
      ftp.releaseType()
      ftp.releasePasv()
      expect(await receive(['first-settled', 'first-unexpected-success'])).toMatchObject({ event: 'first-settled', code: 'FTP_TRANSFER_CANCELLED' })
      expect(await receive(['cancel-settled', 'cancel-failed'])).toMatchObject({ event: 'cancel-settled' })
      expect(await receive(['next-completed', 'next-failed'])).toMatchObject({ event: 'next-completed' })
      expect(ftp.commands).toContain('STOR /tệp%20.txt ')
      expect(ftp.commands).not.toContain('STOR /first')
      expect(ftp.commands).not.toContain('RETR /first')
      expect(Buffer.concat(ftp.uploads).toString()).toBe('next bytes')
      const exited = once(child, 'exit')
      child.send('close')
      await exited
    } finally {
      child?.kill()
      await app?.close()
      await ftp.close()
      await rm(directory, { recursive: true, force: true })
    }
  }, 15_000)
})
