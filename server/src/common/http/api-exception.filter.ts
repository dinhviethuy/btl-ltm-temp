import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { ApiFailure } from './api-response'
import { ApiException } from './api-exception'

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') throw exception

    const http = host.switchToHttp()
    const request = http.getRequest<{
      headers?: Record<string, string>
      requestId?: string
      path?: string
      url?: string
    }>()
    const response = http.getResponse<{
      headersSent?: boolean
      status: (status: number) => { json: (body: ApiFailure) => void }
      setHeader: (name: string, value: string) => void
    }>()
    if (response.headersSent) return

    const requestId = request.requestId ?? request.headers?.['x-request-id'] ?? randomUUID()
    request.requestId = requestId
    response.setHeader('x-request-id', requestId)

    let statusCode = HttpStatus.INTERNAL_SERVER_ERROR
    let code = 'INTERNAL_SERVER_ERROR'
    let message = 'Internal server error'
    let details: unknown

    if (exception instanceof ApiException) {
      statusCode = exception.getStatus()
      code = exception.code
      message = exception.message
      details = exception.details
    } else if (exception instanceof HttpException) {
      statusCode = exception.getStatus()
      code = statusCode === HttpStatus.NOT_FOUND ? 'NOT_FOUND' : 'HTTP_ERROR'
      const payload = exception.getResponse()
      if (typeof payload === 'string') {
        message = payload
      } else if (payload && typeof payload === 'object') {
        const body = payload as { message?: string | string[]; error?: string }
        message = Array.isArray(body.message) ? body.message.join(', ') : body.message ?? body.error ?? exception.message
        details = Array.isArray(body.message) ? body.message : undefined
      } else {
        message = exception.message
      }
    }

    const body: ApiFailure = {
      success: false,
      error: { statusCode, code, message, ...(details === undefined ? {} : { details }) },
      meta: {
        timestamp: new Date().toISOString(),
        requestId,
        path: request.path ?? request.url ?? '/',
      },
    }
    response.status(statusCode).json(body)
  }
}
