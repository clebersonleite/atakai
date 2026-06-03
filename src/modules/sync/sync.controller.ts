import {
  Controller,
  HttpException,
  Post,
  Headers,
  Req,
  Res,
  Get,
  Logger,
} from '@nestjs/common';
import { SyncService } from './sync.service';
import { Request, Response } from 'express';

@Controller('sync')
export class SyncController {
  constructor(
    private readonly syncService: SyncService,
    private readonly logger: Logger,
  ) { }

  @Post('woocommerce/webhook/created-order')
  async handleOrderCreated(
    @Req() req: Request,
    @Res() res: Response,
    @Headers('x-wc-webhook-topic') topic: string,
    @Headers('x-wc-webhook-signature') signature: string,
  ) {
    try {
      await this.syncService.processNewOrder(req.body, signature);

      res.status(200).send({ received: true });
    } catch (error) {
      if (error instanceof HttpException) {
        res.status(error.getStatus()).send({ error: error.message });
      } else {
        console.error('Erro ao processar webhook', error);
        res.status(500).send({ error: 'Erro interno' });
      }
    }
  }

  @Get('all-products-from-apis')
  async getAllProductsFromApis() {
    this.logger.log('Iniciando busca de produtos, estoque e preços...');
    return await this.syncService.syncProducts();
  }

  @Get('stats')
  async getSyncStats(
    @Headers('x-api-key') apiKey: string,
    @Res() res: Response,
  ) {
    const expectedKey = process.env.SYNC_STATS_API_KEY;
    if (!expectedKey || apiKey !== expectedKey) {
      return res.status(401).json({ error: 'Não autorizado' });
    }
    return res.status(200).json(this.syncService.getSyncStats());
  }

  @Get('logs')
  async getSyncLogs(
    @Headers('x-api-key') apiKey: string,
    @Res() res: Response,
  ) {
    const expectedKey = process.env.SYNC_STATS_API_KEY;
    if (!expectedKey || apiKey !== expectedKey) {
      return res.status(401).json({ error: 'Não autorizado' });
    }
    return res.status(200).json(this.syncService.getSyncLogs());
  }
}
