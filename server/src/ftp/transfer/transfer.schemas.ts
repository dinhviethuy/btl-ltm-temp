import { createZodDto } from 'nestjs-zod'
import { z } from 'zod'
import { ApiException } from '../../common/http/api-exception'
import { RemotePathSchema } from '../schemas/file.schemas'

export const TransferIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const TransferSchema = z.object({ transferId: TransferIdSchema, remotePath: RemotePathSchema })
export class DownloadDto extends createZodDto(TransferSchema) {}

// ASCII wire representation; decode once before the ordinary remote-path
// validation. Literal percent sequences remain literal after that one decode.
const EncodedRemotePathSchema = z.string().regex(/^(?:[A-Za-z0-9_.!~*'()-]|%[0-9A-Fa-f]{2})+$/).transform((value, context) => {
  try { return decodeURIComponent(value) }
  catch {
    context.addIssue({ code: 'custom', message: 'Invalid UTF-8 percent-encoded remote path' })
    return z.NEVER
  }
}).pipe(RemotePathSchema)

const UploadHeadersSchema = z.object({
  'x-transfer-id': TransferIdSchema,
  'x-remote-path-encoded': EncodedRemotePathSchema,
  // Raw headers can already have lost whitespace at the HTTP boundary.
  'x-remote-path': z.never().optional(),
  'content-type': z.string().regex(/^application\/octet-stream(?:\s*;.*)?$/i),
  'content-length': z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)).optional(),
})

export function uploadHeaders(headers: unknown) {
  const parsed = UploadHeadersSchema.safeParse(headers)
  if (!parsed.success) throw new ApiException(422, 'VALIDATION_ERROR', 'Request validation failed', parsed.error.issues.map((issue) => ({
    field: issue.path.join('.'), path: issue.path, code: issue.code, message: issue.message,
  })))
  return { transferId: parsed.data['x-transfer-id'], remotePath: parsed.data['x-remote-path-encoded'], totalBytes: parsed.data['content-length'] }
}
