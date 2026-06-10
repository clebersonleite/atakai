import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

interface ProductSnapshot {
  pvenda: number;
  pvendaatacado: number;
  qtminimaatacado: number;
  estoque: number;
}

interface SyncStats {
  lastSync: string | null;
  lastSyncDurationSeconds: number | null;
  productsCreated: number;
  productsUpdated: number;
  productsDeleted: number;
}

import { CreateOmniClientDto } from '../omnia/interfaces/omnia-create-client.interface';
import { OmniaPriceInterface } from '../omnia/interfaces/omnia-price.interface';
import { OmniaProduct } from '../omnia/interfaces/omnia-product';
import { OmniaService } from '../omnia/omnia.service';
import { OmniaStockInterface } from '../omnia/interfaces/omnia-stock.interface';
import { Order } from 'src/shared/interfaces/woocommerce-order.interface';
import { WoocommerceService } from '../woocommerce/woocommerce.service';
import { getIbgeCodeByCep } from 'src/shared/utils/getCityCodeIbge.utils';
import { proccessPaymentMethod } from 'src/shared/utils/proccessPaymentMethod.utils';
import { processBatch } from 'src/shared/utils/proccessBatch.utils';
import { retry } from 'src/shared/utils/retry.utils';

@Injectable()
export class SyncService implements OnModuleInit {
  private readonly SNAPSHOT_PATH = path.join(process.cwd(), '.sync-snapshot.json');
  private readonly STATS_PATH = path.join(process.cwd(), '.sync-stats.json');
  private readonly LOGS_PATH = path.join(process.cwd(), '.sync-logs.json');
  private readonly MAX_LOGS = 500;
  private snapshot: Map<string, string> = new Map();
  private sessionLogs: Array<{ ts: string; level: string; msg: string }> = [];

  constructor(
    private readonly omniaService: OmniaService,
    private readonly woocommerceService: WoocommerceService,
    private readonly logger: Logger,
  ) { }

  async onModuleInit() {
    await this.loadSnapshot();
  }

  private async loadSnapshot(): Promise<void> {
    try {
      if (fs.existsSync(this.SNAPSHOT_PATH)) {
        const raw = fs.readFileSync(this.SNAPSHOT_PATH, 'utf8');
        const data: Record<string, string> = JSON.parse(raw);
        this.snapshot = new Map(Object.entries(data));
        this.logger.log(`Snapshot carregado: ${this.snapshot.size} produtos`);
      } else {
        this.logger.log('Nenhum snapshot encontrado, será criado na próxima sincronização');
      }
    } catch {
      this.logger.warn('Falha ao carregar snapshot, iniciando vazio');
      this.snapshot = new Map();
    }
  }

  private saveSnapshot(newSnapshot: Map<string, string>): void {
    try {
      const data = Object.fromEntries(newSnapshot);
      fs.writeFileSync(this.SNAPSHOT_PATH, JSON.stringify(data), 'utf8');
      this.snapshot = newSnapshot;
    } catch {
      this.logger.warn('Falha ao salvar snapshot');
    }
  }

  private buildSnapshotKey(price: OmniaPriceInterface, estoque: number, name = '', multiplo = 1): string {
    return `${price.pvenda}|${price.pvendaatacado}|${price.qtminimaatacado}|${estoque}|${name}|${multiplo}`;
  }

  private saveStats(stats: SyncStats): void {
    try {
      fs.writeFileSync(this.STATS_PATH, JSON.stringify(stats, null, 2), 'utf8');
    } catch {
      this.logger.warn('Falha ao salvar estatísticas de sincronização');
    }
  }

  getSyncStats(): SyncStats {
    try {
      if (fs.existsSync(this.STATS_PATH)) {
        const raw = fs.readFileSync(this.STATS_PATH, 'utf8');
        return JSON.parse(raw) as SyncStats;
      }
    } catch {
      this.logger.warn('Falha ao ler estatísticas de sincronização');
    }
    return {
      lastSync: null,
      lastSyncDurationSeconds: null,
      productsCreated: 0,
      productsUpdated: 0,
      productsDeleted: 0,
    };
  }

  private appendSyncLog(level: 'log' | 'warn' | 'error', message: string): void {
    if (level === 'log') this.logger.log(message);
    else if (level === 'warn') this.logger.warn(message);
    else this.logger.error(message);
    this.sessionLogs.push({ ts: new Date().toISOString(), level, msg: message });
  }

  private flushSyncLogs(): void {
    try {
      let existing: Array<{ ts: string; level: string; msg: string }> = [];
      if (fs.existsSync(this.LOGS_PATH)) {
        existing = JSON.parse(fs.readFileSync(this.LOGS_PATH, 'utf8'));
      }
      const combined = [...existing, ...this.sessionLogs].slice(-this.MAX_LOGS);
      fs.writeFileSync(this.LOGS_PATH, JSON.stringify(combined), 'utf8');
    } catch {
      // ignore
    } finally {
      this.sessionLogs = [];
    }
  }

  getSyncLogs(limit = 200): Array<{ ts: string; level: string; msg: string }> {
    try {
      if (fs.existsSync(this.LOGS_PATH)) {
        const raw = fs.readFileSync(this.LOGS_PATH, 'utf8');
        const logs = JSON.parse(raw) as Array<{ ts: string; level: string; msg: string }>;
        return logs.slice(-limit);
      }
    } catch {
      // ignore
    }
    return [];
  }

  async compareProduct(sku: string) {
    const [wcProduct, omniaData] = await Promise.all([
      this.woocommerceService.getProductBySku(sku),
      this.omniaService.getProductBySku(sku),
    ]);

    const omniaPrice = omniaData.prices[0] ?? null;
    const omniaStock = omniaData.stock[0] ?? null;
    const omniaProduct = omniaData.products[0] ?? null;

    const wcWholesaleRules =
      wcProduct?.meta_data?.find((m: any) => m.key === '_fixed_price_rules')?.value ?? {};

    const multiplo = Math.max(1, Number(omniaProduct?.multiplo) || 1);
    const effectivePrice = omniaPrice ? parseFloat((Number(omniaPrice.pvenda) * multiplo).toFixed(2)) : null;
    const effectiveWholesale = omniaPrice ? (Number(omniaPrice.pvendaatacado) * multiplo).toFixed(2) : null;

    const omniaWholesaleRules =
      omniaPrice && omniaPrice.qtminimaatacado > 1
        ? { [omniaPrice.qtminimaatacado.toString()]: effectiveWholesale }
        : {};

    const wcPriceNum = wcProduct ? parseFloat(Number(wcProduct.regular_price).toFixed(2)) : null;
    const omniaPriceNum = effectivePrice;
    const wcStockNum = wcProduct?.stock_quantity ?? null;
    const omniaStockNum = omniaStock?.estoque ?? null;

    const priceMatch = wcPriceNum !== null && omniaPriceNum !== null && wcPriceNum === omniaPriceNum;
    const stockMatch = wcStockNum !== null && omniaStockNum !== null && wcStockNum === omniaStockNum;
    const wholesaleMatch = JSON.stringify(wcWholesaleRules) === JSON.stringify(omniaWholesaleRules);

    const omniaName = omniaProduct?.nomeecommerce || omniaProduct?.descricao || null;
    const wcName = wcProduct?.name ?? null;
    const nameMatch = wcName !== null && omniaName !== null && wcName === omniaName;

    return {
      sku,
      foundInWooCommerce: !!wcProduct,
      foundInOmnia: !!omniaPrice,
      woocommerce: wcProduct
        ? {
            id: wcProduct.id,
            name: wcProduct.name,
            status: wcProduct.status,
            regular_price: wcProduct.regular_price,
            stock_quantity: wcProduct.stock_quantity,
            stock_status: wcProduct.stock_status,
            manage_stock: wcProduct.manage_stock,
            weight: wcProduct.weight,
            dimensions: wcProduct.dimensions,
            wholesale_rules: wcWholesaleRules,
          }
        : null,
      omnia: {
        descricao: omniaProduct?.descricao ?? null,
        nomeecommerce: omniaProduct?.nomeecommerce ?? null,
        price: omniaPrice,
        stock: omniaStock,
      },
      diff: {
        name: { match: nameMatch, woo: wcName, omnia: omniaName },
        price: { match: priceMatch, woo: wcPriceNum, omnia: omniaPriceNum },
        stock: { match: stockMatch, woo: wcStockNum, omnia: omniaStockNum },
        wholesaleRules: { match: wholesaleMatch, woo: wcWholesaleRules, omnia: omniaWholesaleRules },
      },
      inSync: nameMatch && priceMatch && stockMatch && wholesaleMatch,
    };
  }

  async processNewOrder(rawBody: Buffer, signature: string) {
    if (!rawBody) {
      this.logger.error('Body não encontrado na requisição');
      throw new BadRequestException('RawBody ausente');
    }

    if (!signature) {
      this.logger.error('Assinatura não encontrada nos headers');
      throw new BadRequestException('Assinatura do webhook ausente');
    }

    const secret = process.env.WC_CREATED_ORDER_WEBHOOK_SECRET!;

    const computedSignature = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('base64');

    if (computedSignature !== signature) {
      this.logger.warn('Assinatura inválida do webhook WooCommerce');
      throw new UnauthorizedException('Assinatura inválida');
    }

    const order: Order = JSON.parse(rawBody.toString('utf8'));

    const ibgeCode = await getIbgeCodeByCep(
      order.billing.postcode.replace('-', ''),
    );

    if (!ibgeCode) {
      this.logger.error('Código IBGE não encontrado para o CEP informado');
      throw new BadRequestException('CEP inválido ou não encontrado');
    }

    const clientFromNewOrder = this.formatClient(order, ibgeCode);

    const newOrderFormatted = this.formatOrder(order, ibgeCode);

    const clientExist = await this.omniaService.getClientByCpfOrCnpj(
      order?.billing?.persontype === 'F'
        ? order?.billing?.cpf
        : order?.billing?.cnpj,
    );

    if (clientExist.length === 0) {
      this.logger.warn(
        clientFromNewOrder,
        'Cliente inexistente, criando novo cliente',
      );

      await this.omniaService.createClient(clientFromNewOrder);
    }

    if (!order.date_paid) {
      this.logger.error('Pedido sem data de pagamento', order);
      return;
    }

    const newOrder = await this.omniaService.createOrder(newOrderFormatted);

    this.logger.log('Pedido criado com sucesso', newOrder);
  }

  async syncProducts() {
    const startTime = Date.now();
    this.sessionLogs = [];
    this.appendSyncLog('log', 'Iniciando sincronização de produtos');

    try {
      const [woocommerceProducts, omniaStock, omniaPrices, omniaProducts] = await Promise.all([
        this.woocommerceService.getAllProductsConcurrent(),
        this.omniaService.getStock(),
        this.omniaService.getPrices(),
        this.omniaService.getProducts(),
      ]);

      const omniaProductDetailsMap = new Map<string, OmniaProduct>();
      omniaProducts.forEach((p) => omniaProductDetailsMap.set(String(p.codprod), p));

      // Mapa de produtos WooCommerce (usando SKU único)
      const wooProductsMap: Map<string, any> = new Map();
      woocommerceProducts.forEach((p) => {
        if (p.sku) {
          const normalizedSku = String(p.sku);
          // Se já existe, mantém o primeiro
          if (!wooProductsMap.has(normalizedSku)) {
            wooProductsMap.set(normalizedSku, p);
          }
        } else {
          this.appendSyncLog('error', `Produto ${p.name} sem SKU, pulando...`);
        }
      });

      // Mapa de produtos Omnia (usando preços, considerando apenas valores únicos)
      const omniaProductsMap: Map<string, any> = new Map();

      // Primeiro, criar um mapa para agrupar por codprod (último preço vence)
      const omniaPricesByCodprod = new Map();

      omniaPrices.forEach((p) => {
        const sku = String(p.codprod);
        omniaPricesByCodprod.set(sku, p); // Último valor sobrescreve
      });

      // Agora popular o mapa principal
      omniaPricesByCodprod.forEach((price, sku) => {
        omniaProductsMap.set(sku, price);
      });

      // Mapa de estoque por codprod para lookup O(1)
      const omniaStockMap = new Map<string, number>();
      omniaStock.forEach((s) => {
        if (s.codprod) omniaStockMap.set(String(s.codprod), s.estoque ?? 0);
      });

      const newProducts: OmniaPriceInterface[] = [];
      const updateProducts: OmniaPriceInterface[] = [];
      const newSnapshot = new Map<string, string>();

      // Verificar produtos do Omnia que não existem no WooCommerce
      for (const [sku, product] of omniaProductsMap) {
        const estoque = omniaStockMap.get(sku) ?? 0;
        const details = omniaProductDetailsMap.get(sku);
        const name = details?.nomeecommerce || details?.descricao || '';
        const multiplo = Math.max(1, Number(details?.multiplo) || 1);
        const snapshotKey = this.buildSnapshotKey(product, estoque, name, multiplo);
        newSnapshot.set(sku, snapshotKey);

        if (!wooProductsMap.has(sku)) {
          newProducts.push(product);
          this.logger.debug(`SKU novo, será criado: ${sku}`);
        } else {
          // Só adiciona à fila se houve mudança desde o último sync
          if (this.snapshot.get(sku) !== snapshotKey) {
            updateProducts.push(product);
          }
        }
      }

      // Mostra os produtos que estão faltando criar no WooCommerce
      if (newProducts.length > 0) {
        this.appendSyncLog('warn', `Faltam ${newProducts.length} produtos para criar no WooCommerce.`);
        newProducts.forEach((p) => {
          this.logger.debug(`Faltando criar: SKU=${p.codprod}`);
        });
      } else {
        this.appendSyncLog('log', 'Todos os produtos estão sincronizados no WooCommerce.');
      }

      this.appendSyncLog('log', `Produtos únicos WooCommerce: ${wooProductsMap.size} | Produtos únicos Omnia: ${omniaProductsMap.size}`);
      this.appendSyncLog('log', `Produtos novos: ${newProducts.length} | Produtos com alteração: ${updateProducts.length} (${omniaProductsMap.size - newProducts.length - updateProducts.length} sem mudança, ignorados)`);

      // Produtos para remover (existem no Woo mas não no Omnia)
      const deleteProducts = Array.from(wooProductsMap.values()).filter(
        (p) => {
          if (!p.sku) return false;
          const normalizedSku = String(p.sku);
          return !omniaProductsMap.has(normalizedSku);
        },
      );

      this.appendSyncLog('log', `Total SKUs a remover/rascunho: ${deleteProducts.length}`);

      // Executar em paralelo para melhor performance
      const [createResult, updateResult, deleteResult] = await Promise.all([
        this.createProductsBatch(newProducts, omniaStock, omniaPrices, wooProductsMap, omniaProductDetailsMap),
        this.updateProductsBatch(updateProducts, omniaStock, omniaPrices, wooProductsMap, omniaProductDetailsMap),
        this.deleteProductsBatch(deleteProducts),
      ]);

      // Persistir snapshot atualizado
      this.saveSnapshot(newSnapshot);

      // Verificar consistência após sincronização
      await this.verifySyncConsistency();

      const duration = Date.now() - startTime;
      const durationInSeconds = (duration / 1000).toFixed(2);

      this.saveStats({
        lastSync: new Date().toISOString(),
        lastSyncDurationSeconds: parseFloat(durationInSeconds),
        productsCreated: createResult.created,
        productsUpdated: updateResult.updated,
        productsDeleted: deleteResult.deleted,
      });

      this.appendSyncLog('log', `Sincronização concluída em ${durationInSeconds}s`);
      this.flushSyncLogs();
    } catch (error) {
      this.appendSyncLog('error', `Erro durante a sincronização: ${String(error)}`);
      this.flushSyncLogs();
      throw error;
    }
  }

  @Cron(CronExpression.EVERY_30_MINUTES)
  async handleCron() {
    this.logger.log('Executando sync automático (a cada hora)');
    await this.syncProducts();
  }

  private async createProductsBatch(
    newProducts: OmniaPriceInterface[],
    omniaStock: OmniaStockInterface[],
    omniaPrices: OmniaPriceInterface[],
    wooProductsMap: Map<string, any>,
    omniaProductDetailsMap: Map<string, OmniaProduct>,
  ): Promise<{ created: number }> {
    const failedList: string[] = [];
    let createdCount = 0;

    await processBatch(newProducts, async (product) => {
      const sku = String(product.codprod);
      const existingProduct = wooProductsMap.get(sku);

      const stockQty =
        omniaStock.find((s) => String(s.codprod) === sku)?.estoque ?? 0;
      const price = omniaPrices.find((pr) => String(pr.codprod) === sku);
      const productDetails = omniaProductDetailsMap.get(sku);

      if (!price) {
        this.appendSyncLog('warn', `Produto ${sku} sem preço no Omnia, pulando`);
        return;
      }

      if (!productDetails) {
        this.appendSyncLog('warn', `Produto ${sku} sem dados de cadastro no Omnia, pulando`);
        return;
      }

      try {
        if (existingProduct) {
          await this.woocommerceService.updateProduct(
            existingProduct.id,
            productDetails,
            { estoque: stockQty },
            price,
          );
          this.appendSyncLog('log', `🔄 SKU ${sku} já existia, atualizado com sucesso`);
        } else {
          const createdProduct = await this.woocommerceService.createProducts(
            productDetails,
            { estoque: stockQty },
            price,
          );
          this.appendSyncLog('log', `✅ Criado SKU ${sku}`);
          createdCount++;

          wooProductsMap.set(sku, createdProduct);
        }
      } catch (err: any) {
        const handled = await this.handleProductError(
          err,
          sku,
          productDetails,
          stockQty,
          price,
          wooProductsMap,
        );
        if (!handled) {
          failedList.push(sku);
          this.appendSyncLog('error', `❌ Erro criar SKU ${sku}: ${err?.response?.data?.message || err?.message || String(err)}`);
        }
      }
    });

    if (failedList.length > 0) {
      this.appendSyncLog('warn', `${failedList.length} produtos não foram criados. SKUs: ${failedList.join(', ')}`);
    }

    return { created: createdCount };
  }

  private async updateProductsBatch(
    updateProducts: OmniaPriceInterface[],
    omniaStock: OmniaStockInterface[],
    omniaPrices: OmniaPriceInterface[],
    wooProductsMap: Map<string, any>,
    omniaProductDetailsMap: Map<string, OmniaProduct>,
  ): Promise<{ updated: number }> {
    const failedUpdates: string[] = [];
    let updatedCount = 0;

    await processBatch(updateProducts, async (product) => {
      const sku = String(product.codprod);
      const wcProduct = wooProductsMap.get(sku);

      if (!wcProduct) {
        this.appendSyncLog('warn', `Produto ${sku} não encontrado no WooCommerce para atualização`);
        return;
      }

      const productDetails = omniaProductDetailsMap.get(sku);
      if (!productDetails) {
        this.appendSyncLog('warn', `Produto ${sku} sem dados de cadastro no Omnia, pulando atualização`);
        return;
      }

      const stockQty =
        omniaStock.find((s) => String(s.codprod) === sku)?.estoque ?? 0;
      const price = omniaPrices.find((pr) => String(pr.codprod) === sku);

      if (!price) {
        this.appendSyncLog('warn', `Produto ${sku} sem preço no Omnia, pulando atualização`);
        return;
      }

      const changes: string[] = [];

      const multiplo = Math.max(1, Number(productDetails.multiplo) || 1);
      const effectivePrice = parseFloat((Number(price.pvenda) * multiplo).toFixed(2));
      const effectiveWholesale = (Number(price.pvendaatacado) * multiplo).toFixed(2);

      const omniaName = productDetails.nomeecommerce || productDetails.descricao;
      if (wcProduct.name && wcProduct.name !== omniaName) {
        changes.push(`nome: "${wcProduct.name}" → "${omniaName}"`);
      }

      if (
        wcProduct.stock_quantity !== undefined &&
        Number(wcProduct.stock_quantity) !== stockQty
      ) {
        changes.push(`estoque: ${wcProduct.stock_quantity} → ${stockQty}`);
      }

      if (
        wcProduct.regular_price &&
        parseFloat(Number(wcProduct.regular_price).toFixed(2)) !== effectivePrice
      ) {
        changes.push(`preço: ${wcProduct.regular_price} → ${effectivePrice}`);
      }

      const wcTieredRules =
        wcProduct.meta_data?.find((m: any) => m.key === '_fixed_price_rules')
          ?.value || {};
      const omniaTieredRules =
        price.qtminimaatacado > 1
          ? { [price.qtminimaatacado.toString()]: effectiveWholesale }
          : {};

      if (JSON.stringify(wcTieredRules) !== JSON.stringify(omniaTieredRules)) {
        changes.push(
          `preço atacado: ${JSON.stringify(wcTieredRules)} → ${JSON.stringify(omniaTieredRules)}`,
        );
      }

      if (changes.length > 0) {
        try {
          await retry(async () => {
            await this.woocommerceService.updateProduct(
              wcProduct.id,
              productDetails,
              { estoque: stockQty },
              price,
            );
            this.appendSyncLog('log', `Atualizado SKU ${sku} | Campos alterados: ${changes.join(', ')}`);
          });
          updatedCount++;
        } catch (err) {
          failedUpdates.push(sku);
          this.appendSyncLog('error', `❌ Erro atualizar SKU ${sku}: ${err?.message || String(err)}`);
        }
      }
    });

    if (failedUpdates.length > 0) {
      this.appendSyncLog('warn', `${failedUpdates.length} produtos não foram atualizados. SKUs: ${failedUpdates.join(', ')}`);
    }

    return { updated: updatedCount };
  }

  private async deleteProductsBatch(deleteProducts: any[]): Promise<{ deleted: number }> {
    const failedDeletes: string[] = [];
    let deletedCount = 0;

    await processBatch(deleteProducts, async (product) => {
      const sku = String(product.sku).trim();

      try {
        await retry(async () => {
          await this.woocommerceService.deleteProduct(product.id);
          this.appendSyncLog('log', `🗑️ Produto removido SKU ${sku}`);
        });
        deletedCount++;
      } catch (err) {
        failedDeletes.push(sku);
        this.appendSyncLog('error', `Erro ao deletar SKU ${sku}: ${err?.message || String(err)}`);
      }
    });

    if (failedDeletes.length > 0) {
      this.appendSyncLog('warn', `${failedDeletes.length} produtos não foram removidos. SKUs: ${failedDeletes.join(', ')}`);
    }

    return { deleted: deletedCount };
  }

  private async handleProductError(
    error: any,
    sku: string,
    product: OmniaProduct,
    stockQty: number,
    price: OmniaPriceInterface,
    wooProductsMap: Map<string, any>,
  ): Promise<boolean> {
    const uniqueSku = error?.response?.data?.data?.unique_sku;

    if (uniqueSku) {
      const normalizedSku = uniqueSku;
      const existingProduct = wooProductsMap.get(normalizedSku);

      if (existingProduct) {
        try {
          await this.woocommerceService.updateProduct(
            existingProduct.id,
            product,
            { estoque: stockQty },
            price,
          );

          this.logger.warn(
            `SKU ${sku} já existe como ${uniqueSku}, atualizado com sucesso`,
          );
          return true;
        } catch (err) {
          this.logger.error(
            err,
            `Erro ao atualizar SKU existente ${uniqueSku}`,
          );
        }
      }
    }

    return false; // se não conseguiu tratar, retorna false
  }

  private async verifySyncConsistency() {
    try {
      const [wooProducts, omniaProducts] = await Promise.all([
        this.woocommerceService.getAllProductsConcurrent(),
        this.omniaService.getPrices(),
      ]);

      const wooSkus = wooProducts
        .map((p) => (p.sku ? p.sku : ''))
        .filter((sku) => sku !== '');

      const omniaSkus = omniaProducts
        .map((p) => String(p.codprod))
        .filter((sku) => sku !== '');

      const wooSkusSet = new Set(wooSkus);
      const omniaSkusSet = new Set(omniaSkus);
      const missingInWoo = omniaSkus.filter((sku) => !wooSkusSet.has(sku));
      const extraInWoo = wooSkus.filter((sku) => !omniaSkusSet.has(sku));

      this.appendSyncLog('log', `Verificação de consistência: faltando no Woo: ${missingInWoo.length} | extras no Woo: ${extraInWoo.length}`);

      if (missingInWoo.length > 0) {
        this.appendSyncLog('warn', `SKUs faltantes: ${missingInWoo.slice(0, 10).join(', ')}${missingInWoo.length > 10 ? '...' : ''}`);
      }

      if (extraInWoo.length > 0) {
        this.appendSyncLog('warn', `SKUs extras: ${extraInWoo.slice(0, 10).join(', ')}${extraInWoo.length > 10 ? '...' : ''}`);
      }

      return { missingInWoo, extraInWoo };
    } catch (error) {
      this.appendSyncLog('error', `Erro na verificação de consistência: ${String(error)}`);
      return { missingInWoo: [], extraInWoo: [] };
    }
  }

  private formatClient(order: Order, ibgeCode: string): CreateOmniClientDto {
    const clientFromNewOrder = {
      codfilial: '3',
      cgcent:
        order?.billing?.persontype === 'F'
          ? order?.billing?.cpf
          : order?.billing?.cnpj,
      ieent: 'ISENTO',
      cliente: `${order.billing.first_name} ${order.billing.last_name}`,
      fantasia: order.billing.company ?? '',
      emailnfe: order.billing.email,
      codcidadeibge: ibgeCode,
      enderent: order.billing.address_1,
      numeroent: order.billing.number,
      complementoent: order.billing.address_2,
      bairroent: order.billing.neighborhood,
      municent: order.billing.city,
      estent: order.billing.state,
      cepent: order.billing.postcode.replace('-', ''),
      telent: order.billing.phone.replace(/\D/g, ''),
      telcelent: (order.billing.cellphone || order.billing.phone).replace(/\D/g, ''),
    };

    return clientFromNewOrder;
  }

  private formatOrder(order: Order, ibgeCode: string) {
    const allProductsValue = order.line_items.reduce((acc, item) => {
      return Number(acc) + Number(item.total);
    }, 0);

    const brand = order.meta_data.find(
      (m) => m.key === '_wc_rede_transaction_brand',
    )?.value;

    const newOrderFormatted = {
      codparceiro: 'DIGITAL',
      numpedweb: `PED-${order.number}`,
      data: order.date_created,
      condvenda: 1,
      codfilial: '3',
      cliente: `${order.billing.first_name} ${order.billing.last_name}`,
      fantasia: order.billing.company ?? '',
      cnpj: order.billing.persontype === 'F' ? order.billing.cpf : order.billing.cnpj,
      ieent: 'ISENTO',
      rg: '',
      emailnfe: order.billing.email,
      enderent: order.billing.address_1,
      complementoent: order.billing.address_2,
      numeroent: order.billing.number,
      bairroent: order.billing.neighborhood,
      cepent: order.billing.postcode.replace('-', ''),
      estent: order.billing.state,
      municent: order.billing.city,
      codcidadeibge: ibgeCode,
      telent: order.billing.phone.replace(/\D/g, ''),
      telcelent: order.billing.phone.replace(/\D/g, ''),
      fretedespacho: 'C',
      idtransportadora: order.shipping_lines[0]?.method_title ?? '',
      vlprodutos: allProductsValue,
      vlfrete: order.shipping_total,
      vltotal: order.total,
      itens: order.line_items.map((item) => {
        return {
          codprod: Number(item.sku),
          nomeproduto: item.name,
          pvenda: item.total,
          pvendabase: item.total,
          qt: item.quantity,
          brinde: 'N',
        };
      }),
      pagamentos: [
        {
          adquirente: 'CIELO',
          formapagamento: brand ? proccessPaymentMethod(brand) : 'PIX',
          idpagamentopix: '',
          nomeformapagamento: order.payment_method_title,
          nsucartao: order.meta_data.find(
            (m) => m.key === '_wc_rede_transaction_nsu',
          )?.value,
          parcelas: Number(
            order.meta_data.find(
              (m) => m.key === '_wc_rede_transaction_installments',
            )?.value ?? 1,
          ),
          valorpago: parseFloat(order.total),
        },
      ],
    };

    return newOrderFormatted;
  }
}
