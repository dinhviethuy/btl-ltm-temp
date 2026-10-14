import { INestApplication } from '@nestjs/common'
import { WsAdapter } from '@nestjs/platform-ws'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { AppModule } from '../src/app.module'
import { FtpClient } from '../src/ftp/core/ftp-client'
import { FTP_CLIENT_FACTORY } from '../src/ftp/ftp-session.service'

describe('FTP remote file API', () => {
  let app: INestApplication
  let sessionId: string
  let state: 'disconnected' | 'connected' | 'authenticated' = 'disconnected'
  const ftp = {
    runOperation: <T>(operation: () => Promise<T>) => operation(),
    connect: jest.fn(async () => { state = 'connected' }),
    login: jest.fn(async () => { state = 'authenticated' }),
    getState: jest.fn(() => state),
    onDisconnected: jest.fn(() => () => undefined),
    disconnect: jest.fn(() => { state = 'disconnected' }),
    list: jest.fn(async () => [{ name: 'readme.txt', type: 'file', size: 12, permissions: '-rw-r--r--', raw: 'raw LIST reply' }]),
    pwd: jest.fn(async () => '/home'),
    cwd: jest.fn(async () => undefined), cdup: jest.fn(async () => undefined),
    mkd: jest.fn(async () => undefined), rename: jest.fn(async () => undefined),
    dele: jest.fn(async () => undefined), rmd: jest.fn(async () => undefined),
    deleteDirectory: jest.fn(async () => undefined),
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(FTP_CLIENT_FACTORY)
      .useValue(() => ftp as unknown as FtpClient)
      .compile()
    app = moduleRef.createNestApplication()
    app.useWebSocketAdapter(new WsAdapter(app))
    app.setGlobalPrefix('api')
    await app.init()
    const created = await request(app.getHttpServer()).post('/api/ftp/sessions').send({ host: '127.0.0.1', port: 21 }).expect(201)
    sessionId = created.body.data.sessionId
    await request(app.getHttpServer()).post(`/api/ftp/sessions/${sessionId}/login`).send({ username: 'alice', password: 'secret' }).expect(201)
  })

  afterAll(async () => { await app?.close() })

  it('returns a normalized listing in the global envelope', async () => {
    const response = await request(app.getHttpServer()).get(`/api/ftp/sessions/${sessionId}/files`).query({ path: '/home' }).expect(200)
    expect(response.body).toMatchObject({
      success: true,
      data: [{ name: 'readme.txt', type: 'file', size: 12, permissions: '-rw-r--r--' }],
      meta: { timestamp: expect.any(String) },
    })
    expect(response.body.data[0]).not.toHaveProperty('raw')
    expect(ftp.list).toHaveBeenCalledWith('/home')
  })

  it('returns the working directory through the PWD route', async () => {
    const response = await request(app.getHttpServer()).get(`/api/ftp/sessions/${sessionId}/pwd`).expect(200)
    expect(response.body).toMatchObject({ success: true, data: '/home', meta: { timestamp: expect.any(String) } })
  })

  it('rejects an equivalent-root recursive delete before any FTP deletion', async () => {
    const deletesBefore = ftp.deleteDirectory.mock.calls.length
    const response = await request(app.getHttpServer())
      .delete(`/api/ftp/sessions/${sessionId}/directories`)
      .query({ path: '/home/..', recursive: 'true' })
      .expect(422)
    expect(response.body.error.code).toBe('VALIDATION_ERROR')
    expect(ftp.deleteDirectory).toHaveBeenCalledTimes(deletesBefore)
  })

  it('preserves spaces through HTTP validation into FTP commands', async () => {
    await request(app.getHttpServer()).get(`/api/ftp/sessions/${sessionId}/files`).query({ path: '/ report ' }).expect(200)
    await request(app.getHttpServer()).post(`/api/ftp/sessions/${sessionId}/directories`).send({ name: ' report ' }).expect(201)
    expect(ftp.list).toHaveBeenCalledWith('/ report ')
    expect(ftp.mkd).toHaveBeenCalledWith(' report ')
  })

  it('registers navigation, create, rename, and delete routes', async () => {
    await request(app.getHttpServer()).post(`/api/ftp/sessions/${sessionId}/cwd`).send({ path: '/home' }).expect(201)
    await request(app.getHttpServer()).post(`/api/ftp/sessions/${sessionId}/cdup`).expect(201)
    await request(app.getHttpServer()).post(`/api/ftp/sessions/${sessionId}/directories`).send({ name: 'docs' }).expect(201)
    await request(app.getHttpServer()).patch(`/api/ftp/sessions/${sessionId}/entries`).send({ from: 'old.txt', to: 'new.txt' }).expect(200)
    await request(app.getHttpServer()).delete(`/api/ftp/sessions/${sessionId}/files`).query({ path: '/home/a.txt' }).expect(200)
    await request(app.getHttpServer()).delete(`/api/ftp/sessions/${sessionId}/directories`).query({ path: '/home/docs', recursive: 'true' }).expect(200)
    expect(ftp.deleteDirectory).toHaveBeenCalledWith('/home/docs')
  })

  it('returns 422 for an invalid rename', async () => {
    const response = await request(app.getHttpServer())
      .patch(`/api/ftp/sessions/${sessionId}/entries`)
      .send({ from: 'old.txt', to: '../escape' })
      .expect(422)
    expect(response.body).toMatchObject({ success: false, error: { code: 'VALIDATION_ERROR', statusCode: 422 } })
    expect(ftp.rename).not.toHaveBeenCalledWith('old.txt', '../escape')
  })

  it('accepts absolute drag/drop move and overwrite backup paths with spaces', async () => {
    const source = '/home/source folder/ my file.txt '
    const destination = '/home/target folder/ my file.txt '
    const backup = `${destination}.ftp-client-backup-123`
    const endpoint = `/api/ftp/sessions/${sessionId}/entries`
    await request(app.getHttpServer()).patch(endpoint).send({ from: destination, to: backup }).expect(200)
    const move = await request(app.getHttpServer()).patch(endpoint).send({ from: source, to: destination }).expect(200)
    expect(move.body).toMatchObject({ success: true, data: { from: source, to: destination } })
    expect(ftp.rename).toHaveBeenCalledWith(destination, backup)
    expect(ftp.rename).toHaveBeenCalledWith(source, destination)
  })

  it('returns 404 for a missing session', async () => {
    const response = await request(app.getHttpServer()).get('/api/ftp/sessions/missing/files').expect(404)
    expect(response.body).toMatchObject({ success: false, error: { code: 'FTP_SESSION_NOT_FOUND', statusCode: 404 } })
  })
})
