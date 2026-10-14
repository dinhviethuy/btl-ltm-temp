import { ArgumentsHost, CallHandler, ExecutionContext } from '@nestjs/common'
import { firstValueFrom, of } from 'rxjs'
import { ApiExceptionFilter } from '../src/common/http/api-exception.filter'
import { SuccessInterceptor } from '../src/common/http/success.interceptor'

describe('HTTP-only global components', () => {
  it('passes WebSocket handler values through the success interceptor unchanged', async () => {
    const value = { event: 'file.progress', percent: 50 }
    const source = of(value)
    const context = {
      getType: () => 'ws',
      switchToHttp: () => {
        throw new Error('HTTP context must not be accessed for WebSocket handlers')
      },
    } as unknown as ExecutionContext
    const handler = { handle: () => source } as CallHandler

    const result = await firstValueFrom(new SuccessInterceptor().intercept(context, handler))

    expect(result).toBe(value)
  })

  it('rethrows WebSocket errors without treating them as HTTP responses', () => {
    const originalError = new Error('socket handler failed')
    const context = {
      getType: () => 'ws',
      switchToHttp: () => {
        throw new Error('HTTP context must not be accessed for WebSocket errors')
      },
    } as unknown as ArgumentsHost

    expect(() => new ApiExceptionFilter().catch(originalError, context)).toThrow(originalError)
  })

  it('uses INTERNAL_SERVER_ERROR for unknown HTTP errors and includes the request path', () => {
    const json = jest.fn()
    const response = {
      headersSent: false,
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json,
    }
    const context = {
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => ({ path: '/api/test', headers: {}, requestId: 'request-123' }),
        getResponse: () => response,
      }),
    } as unknown as ArgumentsHost

    new ApiExceptionFilter().catch(new Error('internal failure'), context)

    expect(response.status).toHaveBeenCalledWith(500)
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: 'INTERNAL_SERVER_ERROR' }),
        meta: expect.objectContaining({ path: '/api/test', requestId: 'request-123' }),
      }),
    )
  })
})
