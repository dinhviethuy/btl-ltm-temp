import { INestApplication } from '@nestjs/common'
import { WsAdapter } from '@nestjs/platform-ws'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { AppModule } from '../src/app.module'
import { startControlServer } from './ftp-test-server'
import { FtpSessionService } from '../src/ftp/ftp-session.service'

describe('FTP session API', () => {
  let app: INestApplication

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    app.useWebSocketAdapter(new WsAdapter(app))
    app.setGlobalPrefix('api')
    await app.init()
  })

  afterAll(async () => { await app.close() })

  it('rejects an invalid port with a validation error', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/ftp/sessions')
      .send({ host: '127.0.0.1', port: 0 })
      .expect(422)
    expect(response.body.error.code).toBe('VALIDATION_ERROR')
  })

  it.each([
    { username: 'alice\r', password: 'secret' },
    { username: 'alice\n', password: 'secret' },
    { username: 'alice\r\nDELE /victim', password: 'secret' },
    { username: 'alice', password: 'secret\r' },
    { username: 'alice', password: 'secret\n' },
    { username: 'alice', password: 'secret\r\nDELE /victim' }
  ])('rejects FTP credential command injection with 422: %j', async (credentials) => {
    const ftp = await startControlServer()
    try {
      const created = await request(app.getHttpServer()).post('/api/ftp/sessions')
        .send({ host: '127.0.0.1', port: ftp.port }).expect(201)
      const { sessionId } = created.body.data
      const response = await request(app.getHttpServer()).post(`/api/ftp/sessions/${sessionId}/login`)
        .send(credentials).expect(422)
      expect(response.body.error).toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 422 })
      expect(ftp.commands).toEqual([])
      await request(app.getHttpServer()).delete(`/api/ftp/sessions/${sessionId}`).expect(200)
    } finally { await ftp.close() }
  })

  it('connects, logs in, reads state, and disconnects using public snapshots', async () => {
    const ftp = await startControlServer()
    try {
      const created = await request(app.getHttpServer())
        .post('/api/ftp/sessions')
        .send({ host: '127.0.0.1', port: ftp.port })
        .expect(201)
      const { sessionId } = created.body.data
      expect(created.body.data).toEqual({ sessionId: expect.any(String), state: 'connected', url: `ftp://127.0.0.1:${ftp.port}` })

      const loggedIn = await request(app.getHttpServer())
        .post(`/api/ftp/sessions/${sessionId}/login`)
        .send({ username: 'alice', password: 'secret' })
        .expect(201)
      expect(loggedIn.body.data).toEqual({ sessionId, state: 'authenticated', url: `ftp://127.0.0.1:${ftp.port}` })
      expect(JSON.stringify(loggedIn.body)).not.toContain('secret')

      const state = await request(app.getHttpServer()).get(`/api/ftp/sessions/${sessionId}`).expect(200)
      expect(state.body.data.state).toBe('authenticated')

      const removed = await request(app.getHttpServer()).delete(`/api/ftp/sessions/${sessionId}`).expect(200)
      expect(removed.body.data.state).toBe('disconnected')
      const missing = await request(app.getHttpServer()).get(`/api/ftp/sessions/${sessionId}`).expect(404)
      expect(missing.body.error.code).toBe('FTP_SESSION_NOT_FOUND')
    } finally {
      await ftp.close()
    }
  })

  it('retires a late-created session when its initial HTTP caller has disconnected', async () => {
    const ftp = await startControlServer(undefined, null)
    const sessions = app.get(FtpSessionService)
    const create = sessions.create.bind(sessions)
    let began!: () => void
    const started = new Promise<void>((resolve) => { began = resolve })
    let completed!: (id: string) => void
    const created = new Promise<string>((resolve) => { completed = resolve })
    const observer = jest.spyOn(sessions, 'create').mockImplementation(async (input) => {
      began()
      const session = await create(input)
      completed(session.sessionId)
      return session
    })
    if (!app.getHttpServer().listening) await app.listen(0, '127.0.0.1')
    const port = (app.getHttpServer().address() as AddressInfo).port
    let requestClosed!: () => void
    const closed = new Promise<void>((resolve) => { requestClosed = resolve })
    app.getHttpServer().once('request', (_request: http.IncomingMessage, response: http.ServerResponse) => response.once('close', requestClosed))
    const pending = http.request(`http://127.0.0.1:${port}/api/ftp/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' } })
    pending.on('error', () => undefined)
    try {
      pending.end(JSON.stringify({ host: '127.0.0.1', port: ftp.port }))
      await started
      pending.destroy()
      await closed
      // TCP establishment is independent of the HTTP close event.
      while (ftp.getControlConnections() === 0) await nextTurn()
      ftp.releaseGreeting()
      const id = await created
      await nextTurn()
      expect(() => sessions.snapshot(id)).toThrow(expect.objectContaining({ code: 'FTP_SESSION_NOT_FOUND' }))
    } finally {
      observer.mockRestore()
      pending.destroy()
      await ftp.close()
    }
  })
})
