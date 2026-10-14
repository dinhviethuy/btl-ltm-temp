import { PassThrough, Readable } from 'node:stream'
import { FtpClient } from '../core/ftp-client'
import { FtpSessionService } from '../ftp-session.service'
import { TransferService } from './transfer.service'
import { TransferGateway } from './transfer.gateway'
import { TransferEvent } from './transfer.types'
import { startTransferServer } from '../../../test/ftp-test-server'

async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(predicate()).toBe(true)
}

describe('TransferService', () => {
  let server: Awaited<ReturnType<typeof startTransferServer>>
  let sessions: FtpSessionService
  let service: TransferService
  let sessionId: string
  let events: { sessionId: string; event: TransferEvent }[]

  async function setup(options: Parameters<typeof startTransferServer>[0] = {}, inactivityMs = 30_000) {
    server = await startTransferServer(options)
    sessions = new FtpSessionService(() => new FtpClient(), inactivityMs)
    sessionId = (await sessions.create({ host: '127.0.0.1', port: server.port })).sessionId
    await sessions.login(sessionId, { username: 'test', password: 'secret' })
    events = []
    // Capture the outbound event boundary; FTP and session lifecycles remain real.
    const gateway = { emit: (id: string, event: TransferEvent) => events.push({ sessionId: id, event }) }
    service = new TransferService(sessions, gateway as unknown as TransferGateway)
  }

  afterEach(async () => { sessions?.onModuleDestroy(); await server?.close() })

  it.each(['TYPE I', 'PASV'])('destroys the upload source immediately when cancelled during %s setup', async (command) => {
    await setup(command === 'TYPE I' ? { holdType: true } : { holdPasv: true })
    const stream = new PassThrough()
    const transfer = service.upload(sessionId, { transferId: 'setup-cancel', remotePath: '/file', stream })
    const rejected = expect(transfer).rejects.toMatchObject({ code: 'FTP_TRANSFER_CANCELLED' })
    try {
      await until(() => server.commands.includes(command))
      service.cancel('setup-cancel')
      expect(stream.destroyed).toBe(true)
      expect(stream.readable).toBe(false)
      expect(stream.writable).toBe(false)
    } finally {
      server.releaseType()
      server.releasePasv()
      await rejected
      stream.destroy()
    }
    expect(server.commands.some((value) => value.startsWith('STOR '))).toBe(false)
    await sessions.get(sessionId).client.noop()
  })

  it('closes a pre-aborted upload source without sending TYPE or STOR', async () => {
    await setup()
    const stream = new PassThrough()
    const controller = new AbortController()
    controller.abort()
    await expect(service.upload(sessionId, { transferId: 'pre-aborted', remotePath: '/file', stream }, controller.signal))
      .rejects.toMatchObject({ code: 'FTP_TRANSFER_CANCELLED' })
    expect(stream.destroyed).toBe(true)
    expect(server.commands).not.toContain('TYPE I')
  })

  it.each(['TYPE I', 'PASV'])('does not acknowledge cancellation before the %s transfer releases its data lease', async (command) => {
    const options = command === 'TYPE I' ? { holdType: true } : { holdPasv: true }
    await setup(options)
    const transfer = service.upload(sessionId, { transferId: 'barrier', remotePath: '/first', stream: new PassThrough() })
    const rejected = expect(transfer).rejects.toMatchObject({ code: 'FTP_TRANSFER_CANCELLED' })
    await server.waitForCommand(command)
    let acknowledged = false
    const cancellation = Promise.resolve(service.cancel('barrier')).then(() => { acknowledged = true })
    try {
      await Promise.resolve()
      expect(acknowledged).toBe(false)
    } finally {
      options.holdType = false
      options.holdPasv = false
      server.releaseType()
      server.releasePasv()
      await cancellation
      await rejected
    }
    await expect(service.upload(sessionId, { transferId: 'next', remotePath: '/next', stream: Readable.from(['next bytes']) })).resolves.toEqual({ transferId: 'next' })
  })

  it('bounds cancellation settlement and retires a session whose FTP setup never responds', async () => {
    await setup({ holdType: true })
    const transfer = service.upload(sessionId, { transferId: 'stuck', remotePath: '/first', stream: new PassThrough() })
    const rejected = expect(transfer).rejects.toMatchObject({ code: 'FTP_TRANSFER_CANCELLED' })
    await server.waitForCommand('TYPE I')
    jest.useFakeTimers()
    try {
      const outcome = Promise.resolve(service.cancel('stuck')).then(() => ({ code: 'ACKNOWLEDGED' }), (error: { code: string }) => error)
      await jest.advanceTimersByTimeAsync(5000)
      expect(await outcome).toMatchObject({ code: 'FTP_TRANSFER_CANCEL_TIMEOUT' })
      expect(() => sessions.get(sessionId)).toThrow(expect.objectContaining({ code: 'FTP_SESSION_NOT_FOUND' }))
    } finally {
      jest.useRealTimers()
      server.releaseType()
      await rejected
    }
  })

  it('rejects a second transfer before a second STOR can use the session data socket', async () => {
    await setup({ holdUpload: true })
    const first = service.upload(sessionId, { transferId: 'first', remotePath: '/first', stream: new PassThrough() })
    const rejected = expect(first).rejects.toMatchObject({ code: 'FTP_TRANSFER_CANCELLED' })
    try {
      await expect(service.upload(sessionId, { transferId: 'second', remotePath: '/second', stream: Readable.from([]) }))
        .rejects.toMatchObject({ code: 'FTP_SESSION_CONFLICT' })
      await until(() => server.commands.includes('STOR /first'))
      expect(server.commands).not.toContain('STOR /second')
    } finally { service.cancel('first'); await rejected }
    await sessions.get(sessionId).client.noop()
    expect(server.getControlConnections()).toBe(1)
    expect(events.filter(({ event }) => event.event === 'transfer.cancelled')).toHaveLength(1)
  })

  it('emits normalized progress with known size and completion only after FTP success', async () => {
    await setup()
    await service.upload(sessionId, { transferId: 'progress', remotePath: '/file', stream: Readable.from([Buffer.alloc(512)]), totalBytes: 1024 })
    expect(events).toContainEqual({ sessionId, event: { event: 'transfer.progress', data: {
      transferId: 'progress', direction: 'upload', transferredBytes: 512, totalBytes: 1024, percentage: 50, bytesPerSecond: expect.any(Number),
    } } })
    expect(events.at(-1)?.event.event).toBe('transfer.completed')
    expect(Buffer.concat(server.uploads)).toHaveLength(512)
    expect(() => service.cancel('progress')).toThrow(expect.objectContaining({ code: 'FTP_TRANSFER_NOT_FOUND' }))
  })

  it('cleans up a rejected transfer so the next attempt is not a session conflict', async () => {
    await setup({ storCode: 550 })
    for (const transferId of ['failed', 'retry']) {
      await expect(service.upload(sessionId, { transferId, remotePath: '/denied', stream: Readable.from([]) }))
        .rejects.toMatchObject({ code: 'FTP_SERVER_ERROR' })
    }
    expect(events.filter(({ event }) => event.event === 'transfer.failed')).toHaveLength(2)
    expect(events.some(({ event }) => event.event === 'transfer.completed')).toBe(false)
  })

  it('does not consume a download before RETR acceptance and maps an immediate rejection', async () => {
    await setup({ retrCode: 550 })
    let consumed = false
    await expect(service.download(sessionId, { transferId: 'denied', remotePath: '/missing' }, async () => { consumed = true }))
      .rejects.toMatchObject({ code: 'FTP_SERVER_ERROR' })
    expect(consumed).toBe(false)
  })

  it('keeps a stalled transfer alive past inactivity and restores expiry after cancellation', async () => {
    await setup({ holdDownload: true }, 150)
    const transfer = service.download(sessionId, { transferId: 'slow', remotePath: '/slow' }, async (stream) => {
      for await (const _chunk of stream) { /* drain */ }
    })
    const rejected = expect(transfer).rejects.toMatchObject({ code: 'FTP_TRANSFER_CANCELLED' })
    await until(() => server.commands.includes('RETR /slow'))
    await new Promise((resolve) => setTimeout(resolve, 220))
    expect(sessions.snapshot(sessionId).state).toBe('authenticated')
    service.cancel('slow')
    await rejected
    await new Promise((resolve) => setTimeout(resolve, 220))
    expect(() => sessions.get(sessionId)).toThrow(expect.objectContaining({ code: 'FTP_SESSION_NOT_FOUND' }))
  })

  it('rejects unknown transfer IDs without affecting a session', async () => {
    await setup()
    expect(() => service.cancel('unknown')).toThrow(expect.objectContaining({ code: 'FTP_TRANSFER_NOT_FOUND' }))
    expect(sessions.snapshot(sessionId).state).toBe('authenticated')
  })

  it.each([undefined, 0])('emits finite normalized progress for totalBytes=%s', async (totalBytes) => {
    await setup()
    await service.upload(sessionId, { transferId: 'size', remotePath: '/empty', stream: Readable.from([]), totalBytes })
    expect(events.at(-1)?.event.data).toMatchObject({ transferredBytes: 0, totalBytes: totalBytes ?? null, percentage: totalBytes === 0 ? 100 : null })
    for (const { event } of events.filter(({ event }) => event.event === 'transfer.progress')) expect(Number.isFinite(event.data.bytesPerSecond)).toBe(true)
  })

  it.each([false, true])('restores idle expiry after upload settles (failure=%s)', async (failure) => {
    await setup(failure ? { storCode: 550 } : {}, 200)
    const transfer = service.upload(sessionId, { transferId: 'lease', remotePath: '/file', stream: Readable.from([]) })
    if (failure) await expect(transfer).rejects.toMatchObject({ code: 'FTP_SERVER_ERROR' })
    else await transfer
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(() => sessions.get(sessionId)).toThrow(expect.objectContaining({ code: 'FTP_SESSION_NOT_FOUND' }))
  })

  it('rejects an active transfer ID collision across otherwise independent sessions', async () => {
    await setup({ holdUpload: true })
    const otherId = (await sessions.create({ host: '127.0.0.1', port: server.port })).sessionId
    await sessions.login(otherId, { username: 'other', password: 'secret' })
    const first = service.upload(sessionId, { transferId: 'duplicate', remotePath: '/first', stream: new PassThrough() })
    const rejected = expect(first).rejects.toMatchObject({ code: 'FTP_TRANSFER_CANCELLED' })
    try {
      await expect(service.upload(otherId, { transferId: 'duplicate', remotePath: '/second', stream: Readable.from([]) }))
        .rejects.toMatchObject({ code: 'FTP_SESSION_CONFLICT' })
      await until(() => server.commands.includes('STOR /first'))
    } finally { service.cancel('duplicate'); await rejected }
  })

  it.each([false, true])('aborts FTP when the download consumer fails (synchronous=%s) and keeps the session reusable', async (synchronous) => {
    await setup({ holdDownload: true })
    const result = service.download(sessionId, { transferId: 'broken-consumer', remotePath: '/large' }, () => {
      if (synchronous) throw new Error('HTTP write failed')
      return Promise.reject(new Error('HTTP write failed'))
    })
    await expect(result).rejects.toMatchObject({ code: 'FTP_SERVER_ERROR' })
    await until(() => server.commands.includes('ABOR'))
    await sessions.get(sessionId).client.noop()
    expect(server.getControlConnections()).toBe(1)
  })
})
