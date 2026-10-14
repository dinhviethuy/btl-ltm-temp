import { Injectable } from '@nestjs/common'
import { posix } from 'node:path'
import { ZodType } from 'zod'
import { ApiException } from '../common/http/api-exception'
import { RemoteFile, RemoteFileType } from './core/types'
import { FtpSessionService } from './ftp-session.service'
import { EntryNameSchema, RemotePathSchema, RenamePathSchema } from './schemas/file.schemas'

export interface RemoteFileDto {
  name: string
  type: RemoteFileType
  size: number
  permissions: string
  owner?: string
  group?: string
  modified?: string
}

@Injectable()
export class FtpService {
  constructor(private readonly sessions: FtpSessionService) {}

  async list(sessionId: string, path?: string): Promise<RemoteFileDto[]> {
    const remotePath = path === undefined ? undefined : this.validate(RemotePathSchema, path)
    const client = this.authenticatedClient(sessionId)
    const release = this.sessions.acquireDataOperation(sessionId)
    try {
      const entries = await this.ftpOperation(() => client.list(remotePath))
      return entries.map((entry) => this.toFileDto(entry))
    } finally { release() }
  }

  async pwd(sessionId: string): Promise<string> {
    const client = this.authenticatedClient(sessionId)
    return this.ftpOperation(() => client.pwd())
  }

  async cwd(sessionId: string, path: string): Promise<string> {
    const remotePath = this.validate(RemotePathSchema, path)
    const client = this.authenticatedClient(sessionId)
    return this.ftpOperation(() => client.runOperation(async () => {
      await client.cwd(remotePath)
      return client.pwd()
    }))
  }

  async cdup(sessionId: string): Promise<string> {
    const client = this.authenticatedClient(sessionId)
    return this.ftpOperation(() => client.runOperation(async () => {
      await client.cdup()
      return client.pwd()
    }))
  }

  async mkdir(sessionId: string, name: string): Promise<{ name: string }> {
    const entryName = this.validate(EntryNameSchema, name)
    const client = this.authenticatedClient(sessionId)
    await this.ftpOperation(() => client.mkd(entryName))
    return { name: entryName }
  }

  async deleteFile(sessionId: string, path: string): Promise<{ path: string }> {
    const remotePath = this.validate(RemotePathSchema, path)
    const client = this.authenticatedClient(sessionId)
    await this.ftpOperation(() => client.dele(remotePath))
    return { path: remotePath }
  }

  async deleteDirectory(sessionId: string, path: string, recursive = false): Promise<{ path: string }> {
    const remotePath = this.validate(RemotePathSchema, path)
    const client = this.authenticatedClient(sessionId)
    // Hold the lease across the whole traversal; recursive core calls use LIST
    // directly and must not acquire a nested lease between child directories.
    const release = recursive ? this.sessions.acquireDataOperation(sessionId) : undefined
    try {
      return await this.ftpOperation(() => client.runOperation(async () => {
        const workingDirectory = posix.isAbsolute(remotePath) ? '/' : await client.pwd()
        if (!posix.isAbsolute(workingDirectory)) {
          throw new ApiException(502, 'FTP_SERVER_ERROR', 'FTP server từ chối thao tác')
        }
        const resolvedPath = posix.resolve(workingDirectory, remotePath)
        if (resolvedPath === '/') {
          throw new ApiException(422, 'VALIDATION_ERROR', 'Không thể xóa thư mục gốc')
        }
        await (recursive ? client.deleteDirectory(resolvedPath) : client.rmd(resolvedPath))
        return { path: resolvedPath }
      }))
    } finally { release?.() }
  }

  async rename(sessionId: string, from: string, to: string): Promise<{ from: string; to: string }> {
    const sourceName = this.validate(RenamePathSchema, from)
    const targetName = this.validate(RenamePathSchema, to)
    const client = this.authenticatedClient(sessionId)
    await this.ftpOperation(() => client.rename(sourceName, targetName))
    return { from: sourceName, to: targetName }
  }

  private authenticatedClient(sessionId: string) {
    const client = this.sessions.get(sessionId).client
    if (client.getState() !== 'authenticated') {
      throw new ApiException(409, 'FTP_SESSION_CONFLICT', 'Phiên FTP chưa đăng nhập')
    }
    return client
  }

  private validate<T>(schema: ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value)
    if (result.success) return result.data
    throw new ApiException(422, 'VALIDATION_ERROR', 'Request validation failed', result.error.issues.map((issue) => ({
      field: 'value', path: issue.path, code: issue.code, message: issue.message,
    })))
  }

  private async ftpOperation<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      if (error instanceof ApiException) throw error
      throw new ApiException(502, 'FTP_SERVER_ERROR', 'FTP server từ chối thao tác')
    }
  }

  private toFileDto(entry: RemoteFile): RemoteFileDto {
    return {
      name: entry.name,
      type: entry.type,
      size: entry.size,
      permissions: entry.permissions,
      ...(entry.owner === undefined ? {} : { owner: entry.owner }),
      ...(entry.group === undefined ? {} : { group: entry.group }),
      ...(entry.modified === undefined ? {} : { modified: entry.modified }),
    }
  }
}
