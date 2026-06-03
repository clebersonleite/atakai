import { Controller, Get, Param } from '@nestjs/common';

import { OmniaService } from './omnia.service';

@Controller('omnia')
export class OmniaController {
  constructor(private readonly omniaService: OmniaService) {}

  @Get('produto/:sku')
  async getProductBySku(@Param('sku') sku: string) {
    return await this.omniaService.getProductBySku(sku);
  }

  @Get('all')
  async getAllData(): Promise<{
    productsCount: number;
    stockCount: number;
    pricesCount: number;
    durationMs: number;
  }> {
    const start = Date.now();

    const [products, stock, prices] = await Promise.all([
      this.omniaService.getProducts(),
      this.omniaService.getStock(),
      this.omniaService.getPrices(),
    ]);

    const durationMs = Date.now() - start;

    console.log(`Produtos: ${products.length}`);
    console.log(`Estoques: ${stock.length}`);
    console.log(`Preços: ${prices.length}`);
    console.log(`Tempo total: ${durationMs}ms`);

    return {
      productsCount: products.length,
      stockCount: stock.length,
      pricesCount: prices.length,
      durationMs,
    };
  }
}
