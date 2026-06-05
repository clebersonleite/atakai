import { Injectable, Logger } from '@nestjs/common';

import { OmniaPriceInterface } from '../omnia/interfaces/omnia-price.interface';
import { OmniaProduct } from '../omnia/interfaces/omnia-product';
import { OmniaStockInterface } from '../omnia/interfaces/omnia-stock.interface';
import { OrderDirection } from 'src/shared/interfaces/order-direction.interface';
import { OrderStatus } from 'src/shared/enum/order-status.enum';
import WooCommerceRestApi from '@woocommerce/woocommerce-rest-api';

// import { WooCreateProductDto } from './dto/woo-create-product.dto';

@Injectable()
export class WoocommerceService {
  private api: WooCommerceRestApi;

  constructor(private readonly logger: Logger) {
    this.api = new WooCommerceRestApi({
      url: process.env.WC_URL,
      consumerKey: process.env.WC_CONSUMER_KEY,
      consumerSecret: process.env.WC_CONSUMER_SECRET,
      version: 'wc/v3',
    });
  }

  async createProducts(
    product: OmniaProduct,
    stock: OmniaStockInterface,
    price: OmniaPriceInterface,
  ) {
    const weightKg = Number(product.pesoliq_gr ?? 0) / 1000;

    const dimensions: Record<string, string> = {};
    if (Number(product.comprimento_cm) > 0)
      dimensions.length = String(Number(product.comprimento_cm));
    if (Number(product.largura_cm) > 0)
      dimensions.width = String(Number(product.largura_cm));
    if (Number(product.altura_cm) > 0)
      dimensions.height = String(Number(product.altura_cm));

    const finalDimensions = Object.keys(dimensions).length
      ? dimensions
      : undefined;

    const productToCreate: any = {
      name: product.nomeecommerce || product.descricao,
      description: product.descricaolonga || '',
      short_description: product.descricaocurta || '',
      sku: String(product.codprod),
      regular_price: String(Number(price.pvenda).toFixed(2)),
      manage_stock: true,
      stock_quantity: Math.floor(Number(stock.estoque ?? 0)),
      stock_status: Number(stock.estoque) > 0 ? 'instock' : 'outofstock',
      weight: String(weightKg),
      dimensions: finalDimensions,
      type: 'simple',
      status: 'draft',
      meta_data: [
        {
          key: '_tiered_price_rules_type',
          value: 'fixed',
        },
        {
          key: '_fixed_price_rules',
          value:
            price.qtminimaatacado > 1
              ? {
                [price.qtminimaatacado.toString()]: Number(
                  price.pvendaatacado,
                ).toFixed(2),
              }
              : {},
        },
      ],
    };

    try {
      return await this.api.post('products', productToCreate);
    } catch (err: any) {
      if (err.response) {
        this.logger.error(
          `Erro criar SKU ${product.codprod}: ${JSON.stringify(err.response.data)}`,
        );
      } else {
        this.logger.error(`Erro criar SKU ${product.codprod}: ${err.message}`);
      }
      throw err;
    }
  }

  async updateProduct(
    wcProductId: number,
    product: OmniaProduct,
    stock: OmniaStockInterface,
    price: OmniaPriceInterface,
  ) {
    const productToUpdate: Partial<any> = {
      name: product.nomeecommerce || product.descricao,
      regular_price: String(Number(price.pvenda).toFixed(2)),
      manage_stock: true,
      stock_quantity: Math.floor(Number(stock.estoque ?? 0)),
      stock_status: Number(stock.estoque) > 0 ? 'instock' : 'outofstock',
      type: 'simple',
      status: 'publish',
      meta_data: [
        {
          key: '_tiered_price_rules_type',
          value: 'fixed',
        },
        {
          key: '_fixed_price_rules',
          value:
            price.qtminimaatacado > 1
              ? {
                [price.qtminimaatacado.toString()]: Number(
                  price.pvendaatacado,
                ).toFixed(2),
              }
              : {},
        },
      ],
    };

    try {
      return await this.api.put(`products/${wcProductId}`, productToUpdate);
    } catch (error) {
      this.logger.error(
        `Erro atualizar SKU ${product.codprod} (wcId: ${wcProductId})`,
        error instanceof Error ? error.stack : String(error),
        JSON.stringify({
          productData: productToUpdate,
          rawError: error.response?.data || error.message,
        }),
      );
      throw error;
    }
  }

  async deleteProduct(productId: number | string) {
    try {
      await this.api.delete(`products/${productId}`);
      this.logger.log(`Produto marcado como draft: ID ${productId}`);
    } catch (err) {
      this.logger.error(
        `Erro ao marcar produto como draft: ID ${productId}`,
        err,
      );
    }
  }

  async getProducts(
    page = 1,
    perPage = 10,
    search?: string,
    orderby: string = 'date',
    order: OrderDirection = 'desc',
  ) {
    const response = await this.api.get('products', {
      page,
      per_page: perPage,
      search: search,
      orderby,
      order,
    });

    const totalRecords = Number(response.headers['x-wp-total']);
    const totalPages = Number(response.headers['x-wp-totalpages']);
    const currentPage = Number(page);

    return {
      pagination: {
        currentPage,
        pageSize: Number(perPage),
        totalRecords,
        totalPages,
        hasNextPage: currentPage < totalPages,
        hasPrevPage: currentPage > 1,
      },
      data: response.data,
    };
  }

  async getProductsStock(
    page = 1,
    perPage = 10,
    orderby: string = 'date',
    order: OrderDirection = 'desc',
  ) {
    const response = await this.api.get('products', {
      page,
      per_page: perPage,
      orderby,
      order,
    });

    const totalRecords = Number(response.headers['x-wp-total']);
    const totalPages = Number(response.headers['x-wp-totalpages']);
    const currentPage = Number(page);

    const stock = response.data.map((product: any) => ({
      id: product.id,
      name: product.name,
      stock_quantity: product.stock_quantity ?? 0,
      stock_status: product.stock_status,
    }));

    return {
      pagination: {
        currentPage,
        pageSize: Number(perPage),
        totalRecords,
        totalPages,
        hasNextPage: currentPage < totalPages,
        hasPrevPage: currentPage > 1,
      },
      data: stock,
    };
  }

  async getOrders(page = 1, perPage = 10, status?: OrderStatus) {
    const response = await this.api.get('orders', {
      page,
      per_page: perPage,
      status,
    });

    const totalRecords = Number(response.headers['x-wp-total']);
    const totalPages = Number(response.headers['x-wp-totalpages']);
    const currentPage = Number(page);

    return {
      pagination: {
        currentPage,
        pageSize: Number(perPage),
        totalRecords,
        totalPages,
        hasNextPage: currentPage < totalPages,
        hasPrevPage: currentPage > 1,
      },
      data: response.data,
    };
  }

  async getCustomers(
    page = 1,
    perPage = 10,
    search?: string,
    orderby: string = 'registered_date',
    order: OrderDirection = 'desc',
  ) {
    const response = await this.api.get('customers', {
      page,
      per_page: perPage,
      search: search,
      orderby,
      order,
    });

    const totalRecords = Number(response.headers['x-wp-total']);
    const totalPages = Number(response.headers['x-wp-totalpages']);
    const currentPage = Number(page);

    return {
      pagination: {
        currentPage,
        pageSize: Number(perPage),
        totalRecords,
        totalPages,
        hasNextPage: currentPage < totalPages,
        hasPrevPage: currentPage > 1,
      },
      data: response.data,
    };
  }

  async getAllCustomersFromOrders(page = 1, perPage = 20) {
    const customersMap = new Map<string, any>();

    let currentPage = 1;

    while (true) {
      const response = await this.api.get('orders', {
        page: currentPage,
        per_page: 100, // buscar em lotes grandes para reduzir requests
        orderby: 'date',
        order: 'desc',
      });

      const orders = response.data;
      if (!orders.length) break;

      for (const order of orders) {
        const { billing, customer_id, date_created } = order;

        // Considera apenas clientes cadastrados
        if (!billing || !billing.email || !customer_id || customer_id <= 0)
          continue;

        if (!customersMap.has(billing.email)) {
          customersMap.set(billing.email, {
            first_name: billing.first_name,
            last_name: billing.last_name,
            email: billing.email,
            phone: billing.phone,
            city: billing.city,
            country: billing.country,
            total_orders: 1,
            total_spent: parseFloat(order.total),
            registered_date: date_created,
          });
        } else {
          const existing = customersMap.get(billing.email);
          existing.total_orders += 1;
          existing.total_spent += parseFloat(order.total);
        }
      }

      // Se tiv4er clientes suficientes para a página solicitada
      if (customersMap.size >= page * perPage) break;

      // Passa para a próxima página do WooCommerce
      currentPage += 1;
      const totalPages = Number(response.headers['x-wp-totalpages']);
      if (currentPage > totalPages) break;
    }

    const allCustomers = Array.from(customersMap.values());

    // Paginação
    const totalRecords = allCustomers.length;
    const totalPages = Math.ceil(totalRecords / perPage);
    const paginatedData = allCustomers.slice(
      (page - 1) * perPage,
      page * perPage,
    );

    return {
      pagination: {
        currentPage: page,
        pageSize: perPage,
        totalRecords,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
      data: paginatedData,
    };
  }

  async getAllProductsConcurrent(): Promise<any[]> {
    const perPage = 100;
    const CONCURRENCY = 3;  // máximo de requisições simultâneas ao WooCommerce
    const DELAY_MS = 500; // pausa entre batches para evitar rate limiting

    const fetchPage = async (page: number, attempt = 1): Promise<any[]> => {
      try {
        const response = await this.api.get('products', {
          per_page: perPage,
          page,
          orderby: 'id',
          order: 'asc',
          status: 'any',
        });
        return response.data;
      } catch (err: any) {
        if (attempt < 3) {
          const delay = DELAY_MS * attempt * 2;
          this.logger.warn(
            `WooCommerce: página ${page} falhou (tentativa ${attempt}), retentando em ${delay}ms...`,
          );
          await new Promise((res) => setTimeout(res, delay));
          return fetchPage(page, attempt + 1);
        }
        this.logger.error(`WooCommerce: página ${page} falhou após 3 tentativas.`);
        return [];
      }
    };

    // Primeira página — obtém total de páginas
    const firstData = await fetchPage(1);

    const firstResponse = await this.api.get('products', {
      per_page: 1,
      page: 1,
      status: 'any',
    });
    const totalPages = parseInt(firstResponse.headers['x-wp-totalpages'], 10) || 1;

    // Busca páginas restantes em batches controlados
    const remainingPages = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
    const extraData: any[] = [];

    for (let i = 0; i < remainingPages.length; i += CONCURRENCY) {
      const batch = remainingPages.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(batch.map((page) => fetchPage(page)));
      batchResults.forEach((pageData) => extraData.push(...pageData));

      if (i + CONCURRENCY < remainingPages.length) {
        await new Promise((res) => setTimeout(res, DELAY_MS));
      }
    }

    const unique = new Map<number, any>();
    for (const product of [...firstData, ...extraData]) {
      unique.set(product.id, product);
    }

    return Array.from(unique.values());
  }

  async getProductBySku(sku: string): Promise<any | null> {
    if (!sku) return null;

    try {
      const response = await this.api.get('products', {
        sku,
        status: 'any',
      });
      const products = response.data;

      if (Array.isArray(products) && products.length > 0) {
        return products[0];
      }

      return null;
    } catch (err: any) {
      const detail = err.response?.data
        ? JSON.stringify(err.response.data)
        : err.message || String(err);
      this.logger.error(`Erro ao buscar produto por SKU ${sku}: ${detail}`);
      return null;
    }
  }

  async deleteProductPermanently(productId: number | string) {
    try {
      // O parâmetro 'force: true' apaga o produto permanentemente
      await this.api.delete(`products/${productId}`, { force: true });
      this.logger.log(`Produto deletado permanentemente: ID ${productId}`);
    } catch (err: any) {
      if (err.response) {
        this.logger.error(
          `Erro ao deletar permanentemente produto ID ${productId}: ${JSON.stringify(
            err.response.data,
          )}`,
        );
      } else {
        this.logger.error(
          `Erro ao deletar permanentemente produto ID ${productId}: ${err.message}`,
        );
      }
      throw err;
    }
  }
}
