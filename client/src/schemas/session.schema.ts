import { z } from 'zod'

export const sessionSchema = z.object({
  sessionId: z.string().min(1),
  state: z.enum(['disconnected', 'connected', 'authenticated']),
  url: z.string()
})

export type ServerSession = z.infer<typeof sessionSchema>
