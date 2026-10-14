import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  StreamableFile,
} from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { map, Observable } from 'rxjs'
import { ApiSuccess } from './api-response'

@Injectable()
export class SuccessInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle()

    const http = context.switchToHttp()
    const request = http.getRequest<{ headers?: Record<string, string>; requestId?: string }>()
    const response = http.getResponse<{ headersSent?: boolean; setHeader?: (name: string, value: string) => void }>()
    const requestId = request.requestId ?? request.headers?.['x-request-id'] ?? randomUUID()
    request.requestId = requestId
    response.setHeader?.('x-request-id', requestId)

    return next.handle().pipe(
      map((data): ApiSuccess<unknown> | unknown => {
        if (
          response.headersSent ||
          data instanceof StreamableFile ||
          data instanceof Readable ||
          (data !== null && typeof data === 'object' && typeof (data as { pipe?: unknown }).pipe === 'function')
        ) {
          return data
        }

        const envelope: ApiSuccess<unknown> = {
          success: true,
          data,
          meta: { timestamp: new Date().toISOString() },
        }
        if (Array.isArray(data)) envelope.meta.total = data.length
        return envelope
      }),
    )
  }
}
