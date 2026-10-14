import { z } from 'zod'

export const remoteFileSchema = z.object({
  name: z.string(),
  type: z.enum(['file', 'directory', 'link']),
  size: z.number().nonnegative(),
  permissions: z.string(),
  owner: z.string().optional(),
  group: z.string().optional(),
  modified: z.string().optional()
})

export const remoteFileListSchema = z.array(remoteFileSchema)
