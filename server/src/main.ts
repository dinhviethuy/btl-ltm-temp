import { ConfigService } from '@nestjs/config'
import { NestFactory } from '@nestjs/core'
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger'
import { WsAdapter } from '@nestjs/platform-ws'
import { randomUUID } from 'node:crypto'
import { AppModule } from './app.module'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  app.setGlobalPrefix('api')

  const config = app.get(ConfigService)
  const clientOrigin = config.get<string>('CLIENT_ORIGIN')
  app.enableCors({ origin: clientOrigin ? [clientOrigin] : false, credentials: true })
  app.useWebSocketAdapter(new WsAdapter(app))
  app.enableShutdownHooks()

  app.use((request: any, response: any, next: () => void) => {
    const suppliedId = request.header('x-request-id')
    const requestId = typeof suppliedId === 'string' && suppliedId.trim() ? suppliedId : randomUUID()
    request.requestId = requestId
    response.setHeader('x-request-id', requestId)
    next()
  })

  const swaggerConfig = new DocumentBuilder()
    .setTitle('FTP Client API')
    .setDescription('FTP client service API')
    .setVersion('1.0')
    .build()
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, swaggerConfig))

  await app.listen(Number(config.get('PORT') ?? 3000))
}

void bootstrap()
