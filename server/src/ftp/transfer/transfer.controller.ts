import { Controller, Delete, Param } from '@nestjs/common'
import { TransferService } from './transfer.service'

@Controller('ftp/transfers')
export class TransferController {
  constructor(private readonly transfers: TransferService) {}

  @Delete(':transferId')
  cancel(@Param('transferId') transferId: string) {
    return this.transfers.cancel(transferId)
  }
}
