export type ApiSuccess<T> = {
  success: true
  data: T
  meta: { timestamp: string; total?: number }
}

export type ApiFailure = {
  success: false
  error: {
    statusCode: number
    code: string
    message: string
    details?: unknown
  }
  meta: { timestamp: string; requestId: string; path: string }
}
