import { z } from 'zod'

import { apiEnvelopeSchema } from '../../schemas/api-envelope.schema.ts'

export class ApiClientError extends Error {
  readonly code: string
  readonly statusCode?: number

  constructor(code: string, message: string, statusCode?: number) {
    super(message)
    this.name = 'ApiClientError'
    this.code = code
    this.statusCode = statusCode
  }
}

function sensitiveValues(init?: RequestInit): string[] {
  if (typeof init?.body !== 'string') return []
  try {
    const body: unknown = JSON.parse(init.body)
    if (body && typeof body === 'object' && 'password' in body) {
      const values = [body.password, 'username' in body ? body.username : undefined]
      return values.filter((value): value is string => typeof value === 'string' && value.length > 0)
    }
  } catch { /* Invalid request bodies are handled by the server. */ }
  return []
}

function redact(message: string, secrets: string[]): string {
  let safe = message
  for (const secret of secrets) safe = safe.split(secret).join('[redacted]')
  return safe
}

export class ApiClient {
  private readonly baseUrl: URL
  private readonly fetcher: typeof fetch

  constructor(baseUrl: string, fetcher: typeof fetch = fetch) {
    this.fetcher = fetcher
    try { this.baseUrl = new URL(baseUrl) }
    catch { throw new ApiClientError('INVALID_BASE_URL', 'Địa chỉ API không hợp lệ') }
    if (!['http:', 'https:'].includes(this.baseUrl.protocol) || this.baseUrl.username || this.baseUrl.password || this.baseUrl.search || this.baseUrl.hash) {
      throw new ApiClientError('INVALID_BASE_URL', 'Địa chỉ API không hợp lệ')
    }
  }

  async request<T>(path: string, init: RequestInit, schema: z.ZodType<T>): Promise<T> {
    return this.parseResponse(await this.requestResponse(path, init), schema, init)
  }

  async requestResponse(path: string, init: RequestInit): Promise<Response> {
    const endpoint = new URL(path.replace(/^\/+/, ''), `${this.baseUrl.toString().replace(/\/+$/, '')}/`)
    if (endpoint.origin !== this.baseUrl.origin || !endpoint.pathname.startsWith(`${this.baseUrl.pathname.replace(/\/+$/, '')}/`)) {
      throw new ApiClientError('INVALID_API_PATH', 'Đường dẫn API không hợp lệ')
    }
    try {
      return await this.fetcher(endpoint.toString(), init)
    } catch {
      throw new ApiClientError('NETWORK_ERROR', 'Không thể kết nối API server')
    }
  }

  async parseResponse<T>(response: Response, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
    const secrets = sensitiveValues(init)
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new ApiClientError('INVALID_RESPONSE', 'API server trả về dữ liệu không hợp lệ', response.status)
    }
    const parsed = apiEnvelopeSchema(schema).safeParse(body)
    if (!parsed.success) {
      throw new ApiClientError('INVALID_RESPONSE', 'API server trả về dữ liệu không hợp lệ', response.status)
    }
    if (!parsed.data.success) {
      const { error } = parsed.data
      throw new ApiClientError(error.code, redact(error.message, secrets), error.statusCode)
    }
    if (!response.ok) {
      throw new ApiClientError('INVALID_RESPONSE', 'API server trả về trạng thái không hợp lệ', response.status)
    }
    return parsed.data.data
  }
}
