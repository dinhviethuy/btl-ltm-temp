import { z } from 'zod'

const metaSchema = z.object({ timestamp: z.string() })

export const apiFailureSchema = z.object({
  success: z.literal(false),
  error: z.object({
    statusCode: z.number().int(),
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional()
  }),
  meta: metaSchema.extend({ requestId: z.string(), path: z.string() })
})

export function apiEnvelopeSchema<T extends z.ZodType>(dataSchema: T) {
  return z.discriminatedUnion('success', [
    z.object({ success: z.literal(true), data: dataSchema, meta: metaSchema.extend({ total: z.number().optional() }) }),
    apiFailureSchema
  ])
}
