import { INestApplication } from '@nestjs/common'
import { WsAdapter } from '@nestjs/platform-ws'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import WebSocket from 'ws'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import * as http from 'node:http'
import { FtpSessionService } from '../src/ftp/ftp-session.service'
import { TransferEvent } from '../src/ftp/transfer/transfer.types'
import { AppModule } from '../src/app.module'
import { startTransferServer } from './ftp-test-server'

describe('FTP HTTP transfers', () => {
  let app: INestApplication
  let server: Awaited<ReturnType<typeof startTransferServer>>
  let sessionId: string
  const sockets = new Set<WebSocket>()

  async function setup(options: Parameters<typeof startTransferServer>[0] = {}) {
    server = await startTransferServer(options)
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    app.useWebSocketAdapter(new WsAdapter(app))
    await app.init()
    const created = await request(app.getHttpServer()).post('/api/ftp/sessions').send({ host: '127.0.0.1', port: server.port }).expect(201)
    sessionId = created.body.data.sessionId
    await request(app.getHttpServer()).post(`/api/ftp/sessions/${sessionId}/login`).send({ username: 'test', password: 'secret' }).expect(201)
  }

  afterEach(async () => { for (const socket of sockets) socket.terminate(); sockets.clear(); await app?.close(); await server?.close() })

  async function websocket(query: string) {
    if (!app.getHttpServer().listening) await app.listen(0, '127.0.0.1')
    const port = (app.getHttpServer().address() as AddressInfo).port
    const socket = new WebSocket(`ws://127.0.0.1:${port}/transfers?${query}`)
    sockets.add(socket)
    await once(socket, 'open')
    return socket
  }

  async function until(predicate: () => boolean) {
    for (let attempt = 0; attempt < 200 && !predicate(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5))
    expect(predicate()).toBe(true)
  }

  it('closes a cancelled HTTP upload source while TYPE is still pending', async () => {
    await setup({ holdType: true })
    await app.listen(0, '127.0.0.1')
    const port = (app.getHttpServer().address() as AddressInfo).port
    const upload = http.request(`http://127.0.0.1:${port}/api/ftp/sessions/${sessionId}/uploads`, { method: 'POST', headers: {
      'content-type': 'application/octet-stream', 'x-transfer-id': 'setup-http', 'x-remote-path-encoded': '%2Ffile', 'content-length': '1024',
    } })
    const closed = new Promise<Error>((resolve) => upload.once('error', resolve))
    try {
      upload.write(Buffer.alloc(512))
      await until(() => server.commands.includes('TYPE I'))
      const cancellation = request(app.getHttpServer()).delete('/api/ftp/transfers/setup-http').expect(200).then((response) => response)
      expect(await closed).toMatchObject({ code: 'ECONNRESET' })
      expect(server.commands.some((command) => command.startsWith('STOR '))).toBe(false)
      server.releaseType()
      await cancellation
    } finally { server.releaseType(); upload.destroy() }
  })

  it('returns 409 to LIST during upload setup without disrupting the upload', async () => {
    await setup({ holdType: true })
    await app.listen(0, '127.0.0.1')
    const upload = request(app.getHttpServer()).post(`/api/ftp/sessions/${sessionId}/uploads`)
      .set('Content-Type', 'application/octet-stream').set('x-transfer-id', 'lease-http').set('x-remote-path-encoded', '%2Ffile')
      .send(Buffer.from('payload')).then((response) => response)
    await until(() => server.commands.includes('TYPE I'))
    try {
      const conflict = await request(app.getHttpServer()).get(`/api/ftp/sessions/${sessionId}/files`).expect(409)
      expect(conflict.body).toMatchObject({ success: false, error: { code: 'FTP_SESSION_CONFLICT', statusCode: 409 } })
      expect(server.commands).not.toContain('PASV')
    } finally { server.releaseType() }
    expect((await upload).status).toBe(201)
    expect(Buffer.concat(server.uploads).toString()).toBe('payload')
    await request(app.getHttpServer()).get(`/api/ftp/sessions/${sessionId}/files`).expect(200)
  })

  it('returns 409 to upload during LIST and permits upload after the listing completes', async () => {
    await setup({ holdList: true })
    await app.listen(0, '127.0.0.1')
    const listing = request(app.getHttpServer()).get(`/api/ftp/sessions/${sessionId}/files`).then((response) => response)
    await until(() => server.commands.includes('LIST'))
    try {
      const conflict = await request(app.getHttpServer()).post(`/api/ftp/sessions/${sessionId}/uploads`)
        .set('Content-Type', 'application/octet-stream').set('x-transfer-id', 'lease-http').set('x-remote-path-encoded', '%2Ffile')
        .send(Buffer.from('payload')).expect(409)
      expect(conflict.body).toMatchObject({ success: false, error: { code: 'FTP_SESSION_CONFLICT', statusCode: 409 } })
      expect(server.commands).not.toContain('TYPE I')
    } finally { server.releaseList() }
    expect((await listing).status).toBe(200)
    await request(app.getHttpServer()).post(`/api/ftp/sessions/${sessionId}/uploads`)
      .set('Content-Type', 'application/octet-stream').set('x-transfer-id', 'lease-http').set('x-remote-path-encoded', '%2Ffile')
      .send(Buffer.from('payload')).expect(201)
  })

  it('cancels a download through HTTP and preserves its ordered FTP session', async () => {
    await setup({ holdDownload: true })
    const socket = await websocket(`sessionId=${sessionId}`)
    const events: TransferEvent[] = []
    socket.on('message', (message) => events.push(JSON.parse(message.toString())))
    const download = request(app.getHttpServer()).get(`/api/ftp/sessions/${sessionId}/downloads`)
      .query({ transferId: 'cancel-download', remotePath: '/large' }).then((response) => response, (error: Error) => error)
    await until(() => server.commands.includes('RETR /large'))
    await request(app.getHttpServer()).delete('/api/ftp/transfers/cancel-download').expect(200)
    await download
    await until(() => events.some((event) => event.event === 'transfer.cancelled'))
    expect(events.filter((event) => event.event === 'transfer.cancelled')).toHaveLength(1)
    expect(events.some((event) => event.event === 'transfer.completed')).toBe(false)
    await app.get(FtpSessionService).get(sessionId).client.noop()
    expect(server.getControlConnections()).toBe(1)
  })

  it('aborts FTP when an HTTP download disconnects prematurely', async () => {
    await setup({ holdDownload: true })
    await app.listen(0, '127.0.0.1')
    const port = (app.getHttpServer().address() as AddressInfo).port
    const download = http.get(`http://127.0.0.1:${port}/api/ftp/sessions/${sessionId}/downloads?transferId=disconnect&remotePath=/large`)
    download.on('error', () => undefined)
    await until(() => server.commands.includes('RETR /large'))
    download.destroy()
    await until(() => server.commands.includes('ABOR'))
    await app.get(FtpSessionService).get(sessionId).client.noop()
    expect(server.getControlConnections()).toBe(1)
  })

  it('does not end the HTTP response or emit completion until the FTP final reply arrives', async () => {
    await setup({ holdDownloadCompletion: true })
    const socket = await websocket(`sessionId=${sessionId}`)
    const events: TransferEvent[] = []
    socket.on('message', (message) => events.push(JSON.parse(message.toString())))
    let ended = false
    const download = request(app.getHttpServer()).get(`/api/ftp/sessions/${sessionId}/downloads`)
      .query({ transferId: 'wait-final', remotePath: '/large' }).then((response) => { ended = true; return response })
    await until(() => events.some((event) => event.event === 'transfer.progress' && (event.data.transferredBytes ?? 0) > 0))
    expect(ended).toBe(false)
    expect(events.some((event) => event.event === 'transfer.completed')).toBe(false)
    server.releaseDownload()
    expect((await download).status).toBe(200)
    await until(() => events.some((event) => event.event === 'transfer.completed'))
  })

  it('broadcasts standard ws progress only to subscribers of the transfer session', async () => {
    await setup()
    const first = await websocket(`sessionId=${sessionId}`)
    const second = await websocket(`sessionId=${sessionId}`)
    const unrelatedId = (await app.get(FtpSessionService).create({ host: '127.0.0.1', port: server.port })).sessionId
    const unrelated = await websocket(`sessionId=${unrelatedId}`)
    const unrelatedEvents: TransferEvent[] = []
    unrelated.on('message', (message) => unrelatedEvents.push(JSON.parse(message.toString())))
    const received: TransferEvent[] = []
    first.on('message', (message) => received.push(JSON.parse(message.toString())))
    const completed = new Promise<TransferEvent>((resolve) => second.on('message', (message) => {
      const event = JSON.parse(message.toString())
      if (event.event === 'transfer.completed') resolve(event)
    }))
    first.send('not JSON')
    first.send(JSON.stringify({ event: 'unknown', data: null }))
    await request(app.getHttpServer()).post(`/api/ftp/sessions/${sessionId}/uploads`)
      .set('Content-Type', 'application/octet-stream').set('x-transfer-id', 'ws-upload').set('x-remote-path-encoded', '%2Ffile').send(Buffer.alloc(512)).expect(201)
    expect(await completed).toMatchObject({ event: 'transfer.completed', data: { transferId: 'ws-upload', direction: 'upload' } })
    expect(received).toContainEqual({ event: 'transfer.progress', data: {
      transferId: 'ws-upload', direction: 'upload', transferredBytes: 512, totalBytes: 512, percentage: 100, bytesPerSecond: expect.any(Number),
    } })
    expect(unrelatedEvents).toEqual([])
    await request(app.getHttpServer()).get('/api/health').expect(200)
  })

  it('closes invalid and missing WebSocket session subscriptions without crashing HTTP', async () => {
    await setup()
    for (const query of ['', 'sessionId=unknown', `sessionId=${sessionId}&sessionId=${sessionId}`]) {
      const socket = await websocket(query)
      const [code] = await once(socket, 'close')
      expect(code).toBe(1008)
    }
    await request(app.getHttpServer()).get('/api/health').expect(200)
  })

  it('closes WebSocket subscribers when their FTP session disconnects', async () => {
    await setup()
    const socket = await websocket(`sessionId=${sessionId}`)
    const closed = once(socket, 'close')
    await request(app.getHttpServer()).delete(`/api/ftp/sessions/${sessionId}`).expect(200)
    expect((await closed)[0]).toBe(1008)
  })

  it('aborts a raw HTTP upload that disconnects before sending all bytes', async () => {
    await setup({ holdUpload: true })
    await app.listen(0, '127.0.0.1')
    const port = (app.getHttpServer().address() as AddressInfo).port
    const upload = http.request(`http://127.0.0.1:${port}/api/ftp/sessions/${sessionId}/uploads`, { method: 'POST', headers: {
      'content-type': 'application/octet-stream', 'x-transfer-id': 'upload-close', 'x-remote-path-encoded': '%2Flarge', 'content-length': '1024',
    } })
    upload.on('error', () => undefined)
    upload.write(Buffer.alloc(512))
    await until(() => server.commands.includes('STOR /large'))
    upload.destroy()
    await until(() => server.commands.includes('ABOR'))
    await app.get(FtpSessionService).get(sessionId).client.noop()
    expect(server.getControlConnections()).toBe(1)
  })

  it('cancels a download after bytes were sent without a false completed event', async () => {
    await setup({ holdDownloadCompletion: true })
    const socket = await websocket(`sessionId=${sessionId}`)
    const events: TransferEvent[] = []
    socket.on('message', (message) => events.push(JSON.parse(message.toString())))
    const download = request(app.getHttpServer()).get(`/api/ftp/sessions/${sessionId}/downloads`)
      .query({ transferId: 'late-cancel', remotePath: '/large' }).then((response) => response, (error: Error) => error)
    await until(() => events.some((event) => (event.data.transferredBytes ?? 0) > 0))
    await request(app.getHttpServer()).delete('/api/ftp/transfers/late-cancel').expect(200)
    expect(await download).toMatchObject({ message: 'aborted', code: 'ECONNRESET' })
    await until(() => events.some((event) => event.event === 'transfer.cancelled'))
    expect(events.some((event) => event.event === 'transfer.completed')).toBe(false)
  })

  it('streams raw upload bytes and returns the success envelope', async () => {
    await setup()
    const bytes = Buffer.from([0, 255, 42, 13, 10])
    const response = await request(app.getHttpServer()).post(`/api/ftp/sessions/${sessionId}/uploads`)
      .set('Content-Type', 'application/octet-stream').set('x-transfer-id', 'upload-1').set('x-remote-path-encoded', '%2Fraw.bin').send(bytes).expect(201)
    expect(response.body).toMatchObject({ success: true, data: { transferId: 'upload-1' } })
    expect(Buffer.concat(server.uploads)).toEqual(bytes)
  })

  it.each([
    ['%2Ft%E1%BB%87p.txt', 'STOR /tệp.txt'], ['%20%2Freport%20', 'STOR  /report '],
    ['%2Fliteral%2520%252F.txt', 'STOR /literal%20%2F.txt'],
  ])('preserves encoded upload path %s through HTTP and the FTP command', async (encoded, command) => {
    await setup()
    await request(app.getHttpServer()).post(`/api/ftp/sessions/${sessionId}/uploads`)
      .set('Content-Type', 'application/octet-stream').set('x-transfer-id', 'encoded-path')
      .set('x-remote-path-encoded', encoded).send(Buffer.from('bytes')).expect(201)
    expect(server.commands).toContain(command)
  })

  it.each(['%', '%FF', '%2Ffile%0D%0ADELE%20%2Fother'])('rejects malformed encoded upload path %s with 422 before FTP', async (encoded) => {
    await setup()
    const response = await request(app.getHttpServer()).post(`/api/ftp/sessions/${sessionId}/uploads`)
      .set('Content-Type', 'application/octet-stream').set('x-transfer-id', 'bad-encoding')
      .set('x-remote-path-encoded', encoded).send('').expect(422)
    expect(response.body.error.code).toBe('VALIDATION_ERROR')
    expect(server.commands).not.toContain('TYPE I')
  })

  it('returns binary download bytes without the JSON envelope and safely encodes the filename', async () => {
    const bytes = Buffer.from([0, 255, 42, 13, 10])
    await setup({ downloadData: bytes })
    const response = await request(app.getHttpServer()).get(`/api/ftp/sessions/${sessionId}/downloads`)
      .query({ transferId: 'download-1', remotePath: '/r"éport.bin' }).expect(200)
    expect(response.headers['content-type']).toBe('application/octet-stream')
    expect(response.headers['content-disposition']).toContain("filename*=UTF-8''r%22%C3%A9port.bin")
    expect(response.body).toEqual(bytes)
  })

  it('returns standard JSON on immediate RETR rejection before any binary header is committed', async () => {
    await setup({ retrCode: 550 })
    const response = await request(app.getHttpServer()).get(`/api/ftp/sessions/${sessionId}/downloads`)
      .query({ transferId: 'missing-1', remotePath: '/missing' }).expect(502)
    expect(response.body).toMatchObject({ success: false, error: { code: 'FTP_SERVER_ERROR', statusCode: 502 } })
    expect(response.headers['content-type']).toContain('application/json')
    expect(response.headers['content-disposition']).toBeUndefined()
  })

  it('preserves standard JSON on immediate STOR rejection without aborting the HTTP request', async () => {
    await setup({ storCode: 550 })
    const response = await request(app.getHttpServer()).post(`/api/ftp/sessions/${sessionId}/uploads`)
      .set('Content-Type', 'application/octet-stream').set('x-transfer-id', 'rejected-upload').set('x-remote-path-encoded', '%2Fdenied')
      .send(Buffer.alloc(512)).expect(502)
    expect(response.body).toMatchObject({ success: false, error: { code: 'FTP_SERVER_ERROR', statusCode: 502 } })
    expect(response.headers['content-type']).toContain('application/json')
  })

  it('returns standard JSON if FTP fails after acceptance but before any binary bytes', async () => {
    await setup({ retrFinalCode: 550 })
    const response = await request(app.getHttpServer()).get(`/api/ftp/sessions/${sessionId}/downloads`)
      .query({ transferId: 'early-failure', remotePath: '/broken' }).expect(502)
    expect(response.body).toMatchObject({ success: false, error: { code: 'FTP_SERVER_ERROR' } })
    expect(response.headers['content-type']).toContain('application/json')
    expect(response.headers['content-disposition']).toBeUndefined()
  })

  it('returns 422 for invalid streaming headers and download query without issuing a transfer', async () => {
    await setup()
    for (const headers of [
      { 'content-type': 'application/json', 'x-transfer-id': 'id', 'x-remote-path-encoded': '%2Ffile' },
      { 'content-type': 'application/octet-stream', 'x-transfer-id': '', 'x-remote-path-encoded': '%2Ffile' },
      { 'content-type': 'application/octet-stream', 'x-transfer-id': 'id', 'x-remote-path-encoded': '%20' },
    ]) {
      const response = await request(app.getHttpServer()).post(`/api/ftp/sessions/${sessionId}/uploads`).set(headers).send('').expect(422)
      expect(response.body.error.code).toBe('VALIDATION_ERROR')
    }
    await request(app.getHttpServer()).get(`/api/ftp/sessions/${sessionId}/downloads`).query({ transferId: 'id', remotePath: '/a\r\nDELE /b' }).expect(422)
    expect(server.commands.some((command) => /^(STOR|RETR)/.test(command))).toBe(false)
  })

  it('returns a standard not-found error for unknown cancellation IDs', async () => {
    await setup()
    const response = await request(app.getHttpServer()).delete('/api/ftp/transfers/unknown').expect(404)
    expect(response.body).toMatchObject({ success: false, error: { code: 'FTP_TRANSFER_NOT_FOUND' } })
  })
})
