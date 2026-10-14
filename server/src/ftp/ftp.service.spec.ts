import { ApiException } from '../common/http/api-exception'
import { FtpClient } from './core/ftp-client'
import { FtpSessionService } from './ftp-session.service'
import { FtpService } from './ftp.service'

describe('FtpService remote file operations', () => {
  const ftp = {
    runOperation: <T>(operation: () => Promise<T>) => operation(),
    getState: jest.fn(() => 'authenticated'),
    list: jest.fn(), pwd: jest.fn(), cwd: jest.fn(), cdup: jest.fn(),
    mkd: jest.fn(), dele: jest.fn(), rmd: jest.fn(),
    deleteDirectory: jest.fn(), rename: jest.fn(),
  }
  const sessions = {
    get: jest.fn(() => ({ sessionId: 'session-1', client: ftp as unknown as FtpClient })),
    acquireDataOperation: () => () => undefined,
  }
  const service = new FtpService(sessions as unknown as FtpSessionService)

  beforeEach(() => {
    jest.clearAllMocks()
    ftp.getState.mockReturnValue('authenticated')
    ftp.list.mockResolvedValue([])
    ftp.pwd.mockResolvedValue('/home')
    for (const command of [ftp.cwd, ftp.cdup, ftp.mkd, ftp.dele, ftp.rmd, ftp.deleteDirectory, ftp.rename]) command.mockResolvedValue(undefined)
  })

  it('lists normalized files through the authenticated session', async () => {
    ftp.list.mockResolvedValue([{ name: 'a.txt', type: 'file', size: 4, permissions: '-rw-r--r--', owner: 'alice', group: 'staff', modified: 'Oct 04', raw: 'private LIST row' }])
    await expect(service.list('session-1', '/')).resolves.toEqual([
      { name: 'a.txt', type: 'file', size: 4, permissions: '-rw-r--r--', owner: 'alice', group: 'staff', modified: 'Oct 04' },
    ])
    expect(sessions.get).toHaveBeenCalledWith('session-1')
    expect(ftp.list).toHaveBeenCalledWith('/')
  })

  it('reads and changes the working directory', async () => {
    await expect(service.pwd('session-1')).resolves.toBe('/home')
    await expect(service.cwd('session-1', '/home/docs')).resolves.toBe('/home')
    await expect(service.cdup('session-1')).resolves.toBe('/home')
    expect(ftp.cwd).toHaveBeenCalledWith('/home/docs')
    expect(ftp.cdup).toHaveBeenCalledTimes(1)
  })

  it('creates a directory by entry name', async () => {
    await expect(service.mkdir('session-1', 'docs')).resolves.toEqual({ name: 'docs' })
    expect(ftp.mkd).toHaveBeenCalledWith('docs')
  })

  it('rejects entry names containing a path separator', async () => {
    await expect(service.mkdir('session-1', '../escape')).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 422 })
    expect(ftp.mkd).not.toHaveBeenCalled()
  })

  it.each(['', '.', '..', 'a/b', 'a\\b'])('rejects invalid entry name %j', async (name) => {
    await expect(service.mkdir('session-1', name)).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 422 })
  })

  it('deletes a file by remote path', async () => {
    await expect(service.deleteFile('session-1', '/home/a.txt')).resolves.toEqual({ path: '/home/a.txt' })
    expect(ftp.dele).toHaveBeenCalledWith('/home/a.txt')
  })

  it('deletes an empty directory without recursion', async () => {
    await expect(service.deleteDirectory('session-1', '/home/empty', false)).resolves.toEqual({ path: '/home/empty' })
    expect(ftp.rmd).toHaveBeenCalledWith('/home/empty')
    expect(ftp.deleteDirectory).not.toHaveBeenCalled()
  })

  it('deletes a directory recursively only when requested', async () => {
    await expect(service.deleteDirectory('session-1', '/home/tree', true)).resolves.toEqual({ path: '/home/tree' })
    expect(ftp.deleteDirectory).toHaveBeenCalledWith('/home/tree')
    expect(ftp.rmd).not.toHaveBeenCalled()
  })

  it.each(['/./', '/home/..', '///home//.././', '../'])('rejects directory path %j when it resolves to FTP root', async (path) => {
    await expect(service.deleteDirectory('session-1', path, true)).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 422 })
    expect(ftp.list).not.toHaveBeenCalled()
    expect(ftp.deleteDirectory).not.toHaveBeenCalled()
    expect(ftp.rmd).not.toHaveBeenCalled()
  })

  it('normalizes a safe non-root directory path before recursive deletion', async () => {
    await expect(service.deleteDirectory('session-1', '/home//docs/./child/..', true)).resolves.toEqual({ path: '/home/docs' })
    expect(ftp.deleteDirectory).toHaveBeenCalledWith('/home/docs')
  })

  it('rejects equivalent-root deletion without recursion', async () => {
    await expect(service.deleteDirectory('session-1', '/home/..', false)).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 422 })
    expect(ftp.rmd).not.toHaveBeenCalled()
  })

  it('preserves spaces in remote paths and entry names', async () => {
    await service.list('session-1', '/ report ')
    await service.mkdir('session-1', ' report ')
    await service.rename('session-1', ' old ', ' new ')
    await service.deleteFile('session-1', '/ report ')
    await service.deleteDirectory('session-1', '/ report ', true)
    expect(ftp.list).toHaveBeenCalledWith('/ report ')
    expect(ftp.mkd).toHaveBeenCalledWith(' report ')
    expect(ftp.rename).toHaveBeenCalledWith(' old ', ' new ')
    expect(ftp.dele).toHaveBeenCalledWith('/ report ')
    expect(ftp.deleteDirectory).toHaveBeenCalledWith('/ report ')
  })

  it('rejects whitespace-only remote paths and entry names', async () => {
    await expect(service.list('session-1', '   ')).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 422 })
    await expect(service.mkdir('session-1', '   ')).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 422 })
    expect(ftp.list).not.toHaveBeenCalled()
    expect(ftp.mkd).not.toHaveBeenCalled()
  })

  it('renames an entry within the working directory', async () => {
    await expect(service.rename('session-1', 'old.txt', 'new.txt')).resolves.toEqual({ from: 'old.txt', to: 'new.txt' })
    expect(ftp.rename).toHaveBeenCalledWith('old.txt', 'new.txt')
  })

  it('moves a remote file to another directory without changing either path', async () => {
    const from = '/home/source folder/ my file.txt '
    const to = '/home/target folder/ my file.txt '
    await expect(service.rename('session-1', from, to)).resolves.toEqual({ from, to })
    expect(ftp.rename).toHaveBeenCalledWith(from, to)
  })

  it.each(['/', '/./', '/home/..', '/home//file', '/home/./file', '../escape', 'a/../b', '/home/file/', '/home\\file', '  ', 'a\r\nb'])
  ('rejects an unsafe rename operand %j', async (path) => {
    await expect(service.rename('session-1', path, '/home/destination.txt')).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 422 })
    await expect(service.rename('session-1', '/home/source.txt', path)).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 422 })
    expect(ftp.rename).not.toHaveBeenCalled()
  })

  it('rejects unauthenticated sessions before invoking FTP', async () => {
    ftp.getState.mockReturnValue('connected')
    await expect(service.list('session-1', '/')).rejects.toMatchObject({ code: 'FTP_SESSION_CONFLICT', status: 409 })
    expect(ftp.list).not.toHaveBeenCalled()
  })

  it('preserves missing-session errors from the session service', async () => {
    sessions.get.mockImplementationOnce(() => { throw new ApiException(404, 'FTP_SESSION_NOT_FOUND', 'Không tìm thấy phiên FTP') })
    await expect(service.pwd('missing')).rejects.toMatchObject({ code: 'FTP_SESSION_NOT_FOUND', status: 404 })
  })

  it('maps FTP reply failures without leaking server text', async () => {
    ftp.dele.mockRejectedValueOnce(new Error('550 password=secret'))
    await expect(service.deleteFile('session-1', '/a.txt')).rejects.toMatchObject({
      code: 'FTP_SERVER_ERROR', status: 502, message: 'FTP server từ chối thao tác',
    })
    await expect(service.deleteFile('session-1', '')).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 422 })
  })
})
