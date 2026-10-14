import { Controller, INestApplication, Post, Body } from '@nestjs/common'
import { WsAdapter } from '@nestjs/platform-ws'
import { Test } from '@nestjs/testing'
import { createZodDto } from 'nestjs-zod'
import request from 'supertest'
import { z } from 'zod'
import { AppModule } from '../src/app.module'

class PortDto extends createZodDto(z.object({ port: z.number().int().min(1).max(65535) })) {}

@Controller('test-validation')
class ValidationFixtureController {
  @Post()
  create(@Body() body: PortDto) {
    return body
  }
}

describe('Zod request validation', () => {
  let app: INestApplication

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [ValidationFixtureController],
    }).compile()
    app = moduleRef.createNestApplication()
    app.useWebSocketAdapter(new WsAdapter(app))
    app.setGlobalPrefix('api')
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  it('returns 422 for an invalid Zod DTO', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/test-validation')
      .send({ port: 70000 })
      .expect(422)
    expect(response.body).toMatchObject({
      success: false,
      error: { statusCode: 422, code: 'VALIDATION_ERROR' },
      meta: { path: '/api/test-validation' },
    })
    expect(response.body.error.details[0]).toMatchObject({
      field: 'port',
      path: ['port'],
      code: 'too_big',
    })
    expect(response.headers['x-request-id']).toEqual(expect.any(String))
    expect(response.body.meta.requestId).toBe(response.headers['x-request-id'])
  })
})
