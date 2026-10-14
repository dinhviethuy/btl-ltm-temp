import { Test } from '@nestjs/testing'
import { ApiException } from '../common/http/api-exception'
import { FtpClient } from './core/ftp-client'
import { FtpSessionService } from './ftp-session.service'
import { FtpModule } from './ftp.module'

function clientDouble() {
  let state: 'disconnected' | 'connected' | 'authenticated' = 'disconnected'
  const disconnectListeners = new Set<() => void>()
  const dropControl = () => {
    state = 'disconnected'
    for (const listener of disconnectListeners) listener()
  }
  const client = {
    connect: jest.fn(async () => {
      state = 'connected'
      return { code: 220, message: 'Ready', lines: ['220 Ready'] }
    }),
    login: jest.fn(async () => {
      state = 'authenticated'
      return { code: 230, message: 'Logged in', lines: ['230 Logged in'] }
    }),
    getState: jest.fn(() => state),
    disconnect: jest.fn(dropControl),
    onDisconnected: jest.fn((listener: () => void) => {
      disconnectListeners.add(listener)
      return () => disconnectListeners.delete(listener)
    }),
    dropControl,
    listenerCount: () => disconnectListeners.size,
  }
  return client
}

describe('FtpSessionService', () => {
  let ftp: ReturnType<typeof clientDouble>
  let service: FtpSessionService

  beforeEach(() => {
    ftp = clientDouble()
    service = new FtpSessionService(() => ftp as unknown as FtpClient)
  })

  it('creates a session and returns a public snapshot', async () => {
    const snapshot = await service.create({ host: '127.0.0.1', port: 2121 })
    expect(snapshot).toEqual({
      sessionId: expect.any(String),
      state: 'connected',
      url: 'ftp://127.0.0.1:2121',
    })
    expect(service.get(snapshot.sessionId).client).toBe(ftp)
  })

  it('reflects authentication without exposing the password', async () => {
    const { sessionId } = await service.create({ host: '127.0.0.1', port: 21 })
    const snapshot = await service.login(sessionId, { username: 'alice', password: 'secret' })
    expect(snapshot).toEqual({ sessionId, url: 'ftp://127.0.0.1:21', state: 'authenticated' })
    expect(JSON.stringify(snapshot)).not.toContain('secret')
    expect(service.snapshot(sessionId)).toEqual(snapshot)
  })

  it('disconnects and removes the session', async () => {
    const { sessionId } = await service.create({ host: '127.0.0.1', port: 21 })
    const snapshot = service.disconnect(sessionId)
    expect(snapshot).toMatchObject({ sessionId, state: 'disconnected' })
    expect(ftp.disconnect).toHaveBeenCalledTimes(1)
    expect(() => service.get(sessionId)).toThrow(new ApiException(404, 'FTP_SESSION_NOT_FOUND', 'Không tìm thấy phiên FTP'))
  })

  it('fails closed when the control connection has dropped', async () => {
    const { sessionId } = await service.create({ host: '127.0.0.1', port: 21 })
    ftp.getState.mockReturnValue('disconnected')
    expect(() => service.get(sessionId)).toThrow(new ApiException(404, 'FTP_SESSION_NOT_FOUND', 'Không tìm thấy phiên FTP'))
  })

  it('maps a failed connection and does not retain it', async () => {
    ftp.connect.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    await expect(service.create({ host: '127.0.0.1', port: 1 })).rejects.toMatchObject({
      code: 'FTP_CONNECTION_FAILED',
      status: 503,
    })
    expect(ftp.disconnect).toHaveBeenCalledTimes(1)
  })

  it('maps connection and login timeouts to 504', async () => {
    ftp.connect.mockRejectedValueOnce(new Error('FTP connect timeout'))
    await expect(service.create({ host: '127.0.0.1', port: 21 })).rejects.toMatchObject({ code: 'FTP_TIMEOUT', status: 504 })

    const { sessionId } = await service.create({ host: '127.0.0.1', port: 21 })
    ftp.login.mockRejectedValueOnce(new Error('FTP command timeout: USER'))
    await expect(service.login(sessionId, { username: 'alice', password: 'secret' })).rejects.toMatchObject({ code: 'FTP_TIMEOUT', status: 504 })
  })

  it('maps rejected credentials to 401 while allowing a retry', async () => {
    const { sessionId } = await service.create({ host: '127.0.0.1', port: 21 })
    ftp.login.mockRejectedValueOnce(new Error('Đăng nhập thất bại: 530 Incorrect password'))
    await expect(service.login(sessionId, { username: 'alice', password: 'wrong' })).rejects.toMatchObject({ code: 'FTP_AUTH_FAILED', status: 401 })
    expect(service.snapshot(sessionId).state).toBe('connected')
  })

  it('expires an idle session and closes its control connection', async () => {
    jest.useFakeTimers()
    try {
      service = new FtpSessionService(() => ftp as unknown as FtpClient, 1_000)
      const { sessionId } = await service.create({ host: '127.0.0.1', port: 21 })
      jest.advanceTimersByTime(1_000)
      expect(ftp.disconnect).toHaveBeenCalledTimes(1)
      expect(() => service.get(sessionId)).toThrow(new ApiException(404, 'FTP_SESSION_NOT_FOUND', 'Không tìm thấy phiên FTP'))
      expect(jest.getTimerCount()).toBe(0)
    } finally {
      jest.useRealTimers()
    }
  })

  it('refreshes idle expiry when the session is accessed', async () => {
    jest.useFakeTimers()
    try {
      service = new FtpSessionService(() => ftp as unknown as FtpClient, 1_000)
      const { sessionId } = await service.create({ host: '127.0.0.1', port: 21 })
      jest.advanceTimersByTime(900)
      service.snapshot(sessionId)
      jest.advanceTimersByTime(999)
      expect(ftp.disconnect).not.toHaveBeenCalled()
      jest.advanceTimersByTime(1)
      expect(ftp.disconnect).toHaveBeenCalledTimes(1)
    } finally {
      jest.useRealTimers()
    }
  })

  it('removes a session immediately when its control connection closes', async () => {
    const { sessionId } = await service.create({ host: '127.0.0.1', port: 21 })
    ftp.dropControl()
    const sessions = (service as unknown as { sessions: Map<string, unknown> }).sessions
    expect(sessions.has(sessionId)).toBe(false)
    expect(ftp.listenerCount()).toBe(0)
  })

  it('maps a login transport disconnect to 503 instead of 401', async () => {
    const { sessionId } = await service.create({ host: '127.0.0.1', port: 21 })
    ftp.login.mockImplementationOnce(async () => {
      ftp.dropControl()
      throw new Error('FTP control connection đã đóng')
    })
    await expect(service.login(sessionId, { username: 'alice', password: 'secret' })).rejects.toMatchObject({
      code: 'FTP_CONNECTION_FAILED',
      status: 503,
    })
  })

  it('clears its timer and listener on explicit disconnect', async () => {
    jest.useFakeTimers()
    try {
      service = new FtpSessionService(() => ftp as unknown as FtpClient, 1_000)
      const { sessionId } = await service.create({ host: '127.0.0.1', port: 21 })
      expect(ftp.listenerCount()).toBe(1)
      service.disconnect(sessionId)
      expect(ftp.listenerCount()).toBe(0)
      expect(jest.getTimerCount()).toBe(0)
    } finally {
      jest.useRealTimers()
    }
  })

  it('does not refresh an evicted session when login resolves after control close', async () => {
    jest.useFakeTimers()
    try {
      service = new FtpSessionService(() => ftp as unknown as FtpClient, 1_000)
      const { sessionId } = await service.create({ host: '127.0.0.1', port: 21 })
      ftp.login.mockImplementationOnce(async () => {
        ftp.dropControl()
        return { code: 230, message: 'Logged in', lines: ['230 Logged in'] }
      })
      await expect(service.login(sessionId, { username: 'alice', password: 'secret' })).rejects.toMatchObject({
        code: 'FTP_CONNECTION_FAILED',
        status: 503,
      })
      expect(jest.getTimerCount()).toBe(0)
    } finally {
      jest.useRealTimers()
    }
  })

  it('closes owned sessions and clears timers during module shutdown', async () => {
    jest.useFakeTimers()
    try {
      service = new FtpSessionService(() => ftp as unknown as FtpClient, 1_000)
      const { sessionId } = await service.create({ host: '127.0.0.1', port: 21 })
      service.onModuleDestroy()
      expect(ftp.disconnect).toHaveBeenCalledTimes(1)
      expect(ftp.listenerCount()).toBe(0)
      expect(jest.getTimerCount()).toBe(0)
      expect(() => service.get(sessionId)).toThrow(new ApiException(404, 'FTP_SESSION_NOT_FOUND', 'Không tìm thấy phiên FTP'))
    } finally {
      jest.useRealTimers()
    }
  })

  it('disconnects pending connections on shutdown and rejects registration if connect resolves late', async () => {
    jest.useFakeTimers()
    let finishConnect!: () => void
    const gate = new Promise<void>((resolve) => { finishConnect = resolve })
    const realConnect = ftp.connect.getMockImplementation()!
    ftp.connect.mockImplementationOnce(async () => { await gate; return realConnect() })
    const opening = service.create({ host: '127.0.0.1', port: 21 })
    const outcome = opening.then((value) => ({ value }), (error: unknown) => ({ error }))
    try {
      service.onModuleDestroy()
      const disconnectedDuringShutdown = ftp.disconnect.mock.calls.length
      finishConnect()
      expect(await outcome).toMatchObject({ error: { status: 503, code: 'FTP_CONNECTION_FAILED' } })
      expect(disconnectedDuringShutdown).toBe(1)
      expect(ftp.getState()).toBe('disconnected')
      expect(ftp.listenerCount()).toBe(0)
      expect((service as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0)
      expect(jest.getTimerCount()).toBe(0)
    } finally {
      finishConnect()
      await outcome
      service.onModuleDestroy()
      jest.useRealTimers()
    }
  })

  it('refuses a new connection after shutdown without creating a client', async () => {
    const factory = jest.fn(() => ftp as unknown as FtpClient)
    service = new FtpSessionService(factory)
    service.onModuleDestroy()
    await expect(service.create({ host: '127.0.0.1', port: 21 })).rejects.toMatchObject({ status: 503, code: 'FTP_CONNECTION_FAILED' })
    expect(factory).not.toHaveBeenCalled()
  })
})

it('constructs FtpModule with its configurable idle timeout provider', async () => {
  const moduleRef = await Test.createTestingModule({ imports: [FtpModule] }).compile()
  expect(moduleRef.get(FtpSessionService)).toBeInstanceOf(FtpSessionService)
  await moduleRef.close()
})
