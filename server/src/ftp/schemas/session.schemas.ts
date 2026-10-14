import { createZodDto } from 'nestjs-zod'
import { z } from 'zod'

export const ConnectSchema = z.object({
  host: z.string().trim().min(1, 'Host không được để trống'),
  port: z.coerce.number().int('Port phải là số nguyên').min(1, 'Port phải từ 1 đến 65535').max(65535, 'Port phải từ 1 đến 65535'),
})

export const LoginSchema = z.object({
  username: z.string().refine((value) => !/[\r\n]/.test(value), 'Username không được chứa CR hoặc LF')
    .transform((value) => value.trim()).pipe(z.string().min(1, 'Username không được để trống')),
  password: z.string().refine((value) => !/[\r\n]/.test(value), 'Password không được chứa CR hoặc LF'),
})

export class ConnectDto extends createZodDto(ConnectSchema) {}
export class LoginDto extends createZodDto(LoginSchema) {}
