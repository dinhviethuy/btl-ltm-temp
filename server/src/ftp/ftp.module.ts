import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { FtpClient } from './core/ftp-client'
import { FtpController } from './ftp.controller'
import { FtpService } from './ftp.service'
import { TransferService } from './transfer/transfer.service'
import { TransferGateway } from './transfer/transfer.gateway'
import { TransferController } from './transfer/transfer.controller'
import { DEFAULT_FTP_SESSION_IDLE_TIMEOUT_MS, FTP_CLIENT_FACTORY, FTP_SESSION_IDLE_TIMEOUT_MS, FtpSessionService } from './ftp-session.service'

@Module({
  imports: [ConfigModule],
  controllers: [FtpController, TransferController],
  providers: [
    FtpSessionService,
    FtpService,
    TransferService,
    TransferGateway,
    { provide: FTP_CLIENT_FACTORY, useValue: () => new FtpClient() },
    {
      provide: FTP_SESSION_IDLE_TIMEOUT_MS,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const configured = Number(config.get<string>('FTP_SESSION_IDLE_TIMEOUT_MS'))
        return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_FTP_SESSION_IDLE_TIMEOUT_MS
      },
    },
  ],
  exports: [FtpSessionService],
})
export class FtpModule {}
