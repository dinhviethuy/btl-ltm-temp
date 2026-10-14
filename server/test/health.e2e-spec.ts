import { INestApplication } from '@nestjs/common'
import { WsAdapter } from '@nestjs/platform-ws'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { AppModule } from '../src/app.module'

describe('health endpoint', () => {
  let app: INestApplication

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    app.useWebSocketAdapter(new WsAdapter(app))
    app.setGlobalPrefix('api')
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  it('GET /api/health returns the success envelope', async () => {
    const response = await request(app.getHttpServer()).get('/api/health').expect(200)
    expect(response.body).toMatchObject({ success: true, data: { status: 'ok' } })
    expect(response.body.meta.timestamp).toEqual(expect.any(String))
  })
})
