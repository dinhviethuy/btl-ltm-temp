import { createZodDto } from 'nestjs-zod'
import { z } from 'zod'

export const RemotePathSchema = z.string().min(1, 'Path không được để trống').refine(
  (path) => path.trim().length > 0 && !/[\r\n]/u.test(path), 'Path không hợp lệ',
)

export const EntryNameSchema = z.string().min(1, 'Tên không được để trống').refine(
  (name) => name.trim().length > 0 && name !== '.' && name !== '..' && !/[\\/\r\n]/u.test(name), 'Tên mục không hợp lệ',
)

export const RenamePathSchema = z.string().min(1, 'Path không được để trống').refine((path) => {
  if (path.trim().length === 0 || /[\x00-\x1f\x7f\\]/u.test(path)) return false
  const segments = (path.startsWith('/') ? path.slice(1) : path).split('/')
  return segments.every((segment) => segment.trim().length > 0 && segment !== '.' && segment !== '..')
}, 'Path đổi tên không hợp lệ')

export const ListFilesSchema = z.object({ path: RemotePathSchema.optional() })
export const RemotePathRequestSchema = z.object({ path: RemotePathSchema })
export const CreateDirectorySchema = z.object({ name: EntryNameSchema })
export const RenameEntrySchema = z.object({ from: RenamePathSchema, to: RenamePathSchema })
export const DeleteDirectorySchema = z.object({
  path: RemotePathSchema,
  recursive: z.enum(['true', 'false']).transform((value) => value === 'true').optional().default(false),
})

export class ListFilesDto extends createZodDto(ListFilesSchema) {}
export class RemotePathDto extends createZodDto(RemotePathRequestSchema) {}
export class CreateDirectoryDto extends createZodDto(CreateDirectorySchema) {}
export class RenameEntryDto extends createZodDto(RenameEntrySchema) {}
export class DeleteDirectoryDto extends createZodDto(DeleteDirectorySchema) {}
