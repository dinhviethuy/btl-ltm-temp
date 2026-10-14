import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { posix } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { FtpSessionService } from './ftp-session.service'
import { FtpService } from './ftp.service'
import { CreateDirectoryDto, DeleteDirectoryDto, ListFilesDto, RemotePathDto, RenameEntryDto } from './schemas/file.schemas'
import { ConnectDto, LoginDto } from './schemas/session.schemas'
import { TransferService } from './transfer/transfer.service'
import { DownloadDto, uploadHeaders } from './transfer/transfer.schemas'

@Controller('ftp/sessions')
export class FtpController {
  constructor(private readonly sessions: FtpSessionService, private readonly files: FtpService, private readonly transfers: TransferService) {}

  @Post(':id/uploads')
  async upload(@Param('id') sessionId: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const input = uploadHeaders(request.headers)
    const { signal, cleanup } = this.httpCancellation(request, response)
    try { return await this.transfers.upload(sessionId, { ...input, stream: request }, signal) }
    finally { cleanup() }
  }

  @Get(':id/downloads')
  async download(@Param('id') sessionId: string, @Query() query: DownloadDto, @Req() request: Request, @Res() response: Response) {
    const { signal, cleanup } = this.httpCancellation(request, response)
    try {
      await this.transfers.download(sessionId, query, async (stream) => {
        const filename = posix.basename(query.remotePath).replace(/[\x00-\x1f\x7f]/g, '_') || 'download'
        const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, '_')
        const encoded = encodeURIComponent(filename).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
        response.setHeader('Content-Type', 'application/octet-stream')
        response.setHeader('Content-Disposition', `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`)
        await pipeline(stream, response, { signal, end: false })
      }, signal)
      response.end()
    } catch (error) {
      if (response.headersSent) response.destroy()
      else {
        response.removeHeader('Content-Type')
        response.removeHeader('Content-Disposition')
        throw error
      }
    } finally { cleanup() }
  }

  private httpCancellation(request: Request, response: Response) {
    const controller = new AbortController()
    const abort = () => controller.abort()
    const close = () => { if (!response.writableFinished) abort() }
    request.once('aborted', abort)
    response.once('close', close)
    if (request.aborted || response.destroyed) abort()
    return { signal: controller.signal, cleanup: () => {
      request.off('aborted', abort)
      response.off('close', close)
    } }
  }

  @Post()
  async create(@Body() body: ConnectDto, @Res({ passthrough: true }) response: Response) {
    let sessionId: string | undefined
    let abandoned = response.destroyed
    const retire = () => {
      if (response.writableFinished) return
      abandoned = true
      if (sessionId) {
        try { this.sessions.disconnect(sessionId) } catch { /* already expired */ }
      }
    }
    response.once('close', retire)
    response.once('finish', () => response.off('close', retire))
    try {
      const session = await this.sessions.create(body)
      sessionId = session.sessionId
      if (abandoned || response.destroyed) retire()
      return session
    } catch (error) {
      response.off('close', retire)
      throw error
    }
  }

  @Get(':id')
  snapshot(@Param('id') sessionId: string) {
    return this.sessions.snapshot(sessionId)
  }

  @Post(':id/login')
  login(@Param('id') sessionId: string, @Body() body: LoginDto) {
    return this.sessions.login(sessionId, body)
  }

  @Delete(':id')
  disconnect(@Param('id') sessionId: string) {
    return this.sessions.disconnect(sessionId)
  }

  @Get(':id/files')
  list(@Param('id') sessionId: string, @Query() query: ListFilesDto) {
    return this.files.list(sessionId, query.path)
  }

  @Get(':id/pwd')
  pwd(@Param('id') sessionId: string) {
    return this.files.pwd(sessionId)
  }

  @Post(':id/cwd')
  cwd(@Param('id') sessionId: string, @Body() body: RemotePathDto) {
    return this.files.cwd(sessionId, body.path)
  }

  @Post(':id/cdup')
  cdup(@Param('id') sessionId: string) {
    return this.files.cdup(sessionId)
  }

  @Post(':id/directories')
  mkdir(@Param('id') sessionId: string, @Body() body: CreateDirectoryDto) {
    return this.files.mkdir(sessionId, body.name)
  }

  @Patch(':id/entries')
  rename(@Param('id') sessionId: string, @Body() body: RenameEntryDto) {
    return this.files.rename(sessionId, body.from, body.to)
  }

  @Delete(':id/files')
  deleteFile(@Param('id') sessionId: string, @Query() query: RemotePathDto) {
    return this.files.deleteFile(sessionId, query.path)
  }

  @Delete(':id/directories')
  deleteDirectory(@Param('id') sessionId: string, @Query() query: DeleteDirectoryDto) {
    return this.files.deleteDirectory(sessionId, query.path, query.recursive)
  }
}
