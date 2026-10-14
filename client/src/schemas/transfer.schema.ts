import { z } from 'zod'

export const transferIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
export const transferResultSchema = z.object({ transferId: transferIdSchema })
export const transferInputSchema = transferResultSchema.extend({
  localPath: z.string().min(1),
  remotePath: z.string().min(1).regex(/^[^\x00-\x1f\x7f]+$/).refine((path) => path.trim().length > 0),
  totalBytes: z.number().int().nonnegative().optional()
})
export const transferProgressSchema = z.object({
  transferId: transferIdSchema,
  transferredBytes: z.number().nonnegative(),
  totalBytes: z.number().nonnegative().nullable(),
  bytesPerSecond: z.number().nonnegative()
})

const summarySchema = transferResultSchema.extend({
  direction: z.enum(['upload', 'download']),
  transferredBytes: z.number().nonnegative(),
  totalBytes: z.number().nonnegative().nullable(),
  percentage: z.number().min(0).max(100).nullable()
})
const failureSchema = summarySchema.extend({ error: z.object({ code: z.string().min(1), message: z.string() }) })

export const transferEventSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('transfer.progress'), data: summarySchema.extend({ bytesPerSecond: z.number().nonnegative() }) }),
  z.object({ event: z.literal('transfer.completed'), data: summarySchema }),
  z.object({ event: z.literal('transfer.failed'), data: failureSchema }),
  z.object({ event: z.literal('transfer.cancelled'), data: failureSchema })
])
