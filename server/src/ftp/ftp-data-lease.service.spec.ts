import { PassThrough, Readable } from 'node:stream'
import { startTransferServer } from '../../test/ftp-test-server'
import { FtpClient } from './core/ftp-client'
import { FtpSessionService } from './ftp-session.service'
import { FtpService } from './ftp.service'
import { TransferGateway } from './transfer/transfer.gateway'
import { TransferService } from './transfer/transfer.service'

async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(predicate()).toBe(true)
}

async function outcome(promise: Promise<unknown>) {
  return Promise.race([
    promise.then((value) => ({ value }), (error: unknown) => ({ error })),
    new Promise((resolve) => setTimeout(() => resolve({ pending: true }), 100)),
  ])
}

describe('shared FTP session data-operation lease', () => {
  let server: Awaited<ReturnType<typeof startTransferServer>>
  let sessions: FtpSessionService
  let files: FtpService
  let transfers: TransferService
  let sessionId: string

  async function setup(options: Parameters<typeof startTransferServer>[0], inactivityMs = 30_000) {
    server = await startTransferServer(options)
    sessions = new FtpSessionService(() => new FtpClient(), inactivityMs)
    sessionId = (await sessions.create({ host: '127.0.0.1', port: server.port })).sessionId
    await sessions.login(sessionId, { username: 'test', password: 'secret' })
    files = new FtpService(sessions)
    transfers = new TransferService(sessions, { emit: () => undefined } as unknown as TransferGateway)
  }

  afterEach(async () => { sessions?.onModuleDestroy(); await server?.close() })

  it.each([false, true])('rejects competing listing before PASV during upload setup (recursive=%s)', async (recursive) => {
    await setup({ holdType: true })
    const source = new PassThrough()
    const upload = transfers.upload(sessionId, { transferId: 'upload', remotePath: '/file', stream: source }).catch((error: unknown) => error)
    let listing: Promise<unknown> | undefined
    try {
      await until(() => server.commands.includes('TYPE I'))
      listing = recursive ? files.deleteDirectory(sessionId, '/tree', true) : files.list(sessionId, '/')
      expect(await outcome(listing)).toMatchObject({ error: { code: 'FTP_SESSION_CONFLICT', status: 409 } })
      expect(server.commands).not.toContain('PASV')
      transfers.cancel('upload')
      server.releaseType()
      await upload
      await expect(files.list(sessionId, '/')).resolves.toEqual([])
    } finally {
      sessions.onModuleDestroy()
      await Promise.allSettled([upload, ...(listing ? [listing] : [])])
      source.destroy()
    }
  })

  it.each([false, true])('rejects upload before TYPE/PASV while listing owns the data channel (recursive=%s)', async (recursive) => {
    await setup({ holdList: true })
    const listing = recursive ? files.deleteDirectory(sessionId, '/tree', true) : files.list(sessionId, '/')
    void listing.catch(() => undefined)
    let upload: Promise<unknown> | undefined
    try {
      await until(() => server.commands.some((command) => command.startsWith('LIST ')))
      upload = transfers.upload(sessionId, { transferId: 'blocked', remotePath: '/file', stream: Readable.from([]) })
      expect(await outcome(upload)).toMatchObject({ error: { code: 'FTP_SESSION_CONFLICT', status: 409 } })
      expect(server.commands).not.toContain('TYPE I')
      expect(server.commands.filter((command) => command === 'PASV')).toHaveLength(1)
      server.releaseList()
      await listing
      await expect(transfers.upload(sessionId, { transferId: 'retry', remotePath: '/file', stream: Readable.from([]) }))
        .resolves.toEqual({ transferId: 'retry' })
    } finally { sessions.onModuleDestroy(); await Promise.allSettled([listing, ...(upload ? [upload] : [])]) }
  })

  it('retains a stalled LIST past idle expiry and restores normal expiry when it finishes', async () => {
    await setup({ holdList: true }, 200)
    const listing = files.list(sessionId, '/')
    void listing.catch(() => undefined)
    try {
      await until(() => server.commands.includes('LIST /'))
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(sessions.snapshot(sessionId).state).toBe('authenticated')
      server.releaseList()
      await listing
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(() => sessions.get(sessionId)).toThrow(expect.objectContaining({ code: 'FTP_SESSION_NOT_FOUND' }))
    } finally { sessions.onModuleDestroy(); await Promise.allSettled([listing]) }
  })

  it.each([false, true])('releases the shared data lease after a failed LIST (recursive=%s)', async (recursive) => {
    await setup({ listCode: 550 })
    await expect(recursive ? files.deleteDirectory(sessionId, '/tree', true) : files.list(sessionId, '/'))
      .rejects.toMatchObject({ code: 'FTP_SERVER_ERROR' })
    await expect(transfers.upload(sessionId, { transferId: 'after-failure', remotePath: '/file', stream: Readable.from([]) }))
      .resolves.toEqual({ transferId: 'after-failure' })
  })

  it('retires a failed LIST session before its data lease can admit another operation', async () => {
    await setup({ dropDataBeforeReply: true })
    await expect(files.list(sessionId, '/')).rejects.toMatchObject({ code: 'FTP_SERVER_ERROR' })
    expect(() => sessions.snapshot(sessionId)).toThrow(expect.objectContaining({ code: 'FTP_SESSION_NOT_FOUND' }))
    await expect(files.list(sessionId, '/next')).rejects.toMatchObject({ code: 'FTP_SESSION_NOT_FOUND' })
    expect(server.commands.filter((command) => command === 'PASV')).toHaveLength(1)
  })

  it.each([false, true])('releases the shared data lease after an upload settles (failure=%s)', async (failure) => {
    await setup(failure ? { storCode: 550 } : {})
    const upload = transfers.upload(sessionId, { transferId: 'first', remotePath: '/file', stream: Readable.from([]) })
    if (failure) await expect(upload).rejects.toMatchObject({ code: 'FTP_SERVER_ERROR' })
    else await upload
    await expect(files.list(sessionId, '/')).resolves.toEqual([])
  })

  it('rejects a second LIST while the first owns the data channel', async () => {
    await setup({ holdList: true })
    const first = files.list(sessionId, '/')
    try {
      await until(() => server.commands.includes('LIST /'))
      await expect(files.list(sessionId, '/other')).rejects.toMatchObject({ code: 'FTP_SESSION_CONFLICT' })
      expect(server.commands.filter((command) => command === 'PASV')).toHaveLength(1)
    } finally { server.releaseList(); await first }
  })

  it('rejects competing download during LIST without sending TYPE', async () => {
    await setup({ holdList: true })
    const first = files.list(sessionId, '/')
    try {
      await until(() => server.commands.includes('LIST /'))
      await expect(transfers.download(sessionId, { transferId: 'download', remotePath: '/file' }, async () => undefined))
        .rejects.toMatchObject({ code: 'FTP_SESSION_CONFLICT' })
      expect(server.commands).not.toContain('TYPE I')
    } finally { server.releaseList(); await first }
  })

  it('releases an evicted session lease without resurrecting it or blocking a new session', async () => {
    await setup({ holdList: true })
    const first = files.list(sessionId, '/')
    const rejected = expect(first).rejects.toMatchObject({ code: 'FTP_SERVER_ERROR' })
    await until(() => server.commands.includes('LIST /'))
    sessions.disconnect(sessionId)
    await rejected
    expect(() => sessions.get(sessionId)).toThrow(expect.objectContaining({ code: 'FTP_SESSION_NOT_FOUND' }))
    const replacement = (await sessions.create({ host: '127.0.0.1', port: server.port })).sessionId
    await sessions.login(replacement, { username: 'test', password: 'secret' })
    await expect(transfers.upload(replacement, { transferId: 'new-session', remotePath: '/file', stream: Readable.from([]) }))
      .resolves.toEqual({ transferId: 'new-session' })
  })
})
