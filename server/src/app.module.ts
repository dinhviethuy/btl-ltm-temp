import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core'
import { ApiExceptionFilter } from './common/http/api-exception.filter'
import { SuccessInterceptor } from './common/http/success.interceptor'
import { ZodValidationPipe } from './common/validation/zod-validation.pipe'
import { HealthModule } from './health/health.module'
import { FtpModule } from './ftp/ftp.module'

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), HealthModule, FtpModule],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: SuccessInterceptor },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
    { provide: APP_PIPE, useClass: ZodValidationPipe },
  ],
})
export class AppModule {}
