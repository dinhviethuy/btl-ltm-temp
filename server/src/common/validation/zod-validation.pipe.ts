import { Injectable, PipeTransform, ArgumentMetadata } from '@nestjs/common'
import { ZodType } from 'zod'
import { ApiException } from '../http/api-exception'

type ZodDtoConstructor = { schema?: ZodType }

@Injectable()
export class ZodValidationPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    const schema = (metadata.metatype as ZodDtoConstructor | undefined)?.schema
    if (!schema) return value

    const result = schema.safeParse(value)
    if (result.success) return result.data

    const details = result.error.issues.map((issue) => ({
      field: issue.path.map(String).join('.') || 'body',
      path: issue.path,
      code: issue.code,
      message: issue.message,
    }))
    throw new ApiException(422, 'VALIDATION_ERROR', 'Request validation failed', details)
  }
}
