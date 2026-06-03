import * as https from 'https';

import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosError, AxiosInstance } from 'axios';

import { ConfigService } from '@nestjs/config';
import { CreateOmniClientDto } from './interfaces/omnia-create-client.interface';
import { OmniClient } from './interfaces/omnia-client.interface';
import { OmniaPaginatedResponse } from './interfaces/omnia-paginated.interface';
import { OmniaPriceInterface } from './interfaces/omnia-price.interface';
import { OmniaProduct } from './interfaces/omnia-product';
import { OmniaStockInterface } from './interfaces/omnia-stock.interface';

interface AuthResponse {
  token: string;
}

@Injectable()
export class OmniaService {
  private readonly logger = new Logger(OmniaService.name);
  private api: AxiosInstance;

  constructor(private configService: ConfigService) {
    const httpsAgent = new https.Agent({ rejectUnauthorized: false });

    this.api = axios.create({
      baseURL: this.configService.get<string>('OMNIA_API_URL'),
      timeout: 60000,
      httpsAgent,
    });
  }

  // ==========================
  // Função para formatar erros
  // ==========================
  private formatAxiosError(error: any) {
    if (error instanceof AxiosError) {
      return {
        message: error.message,
        code: error.code,
        url: error.config?.url,
        method: error.config?.method,
        status: error.response?.status,
        data: error.response?.data,
      };
    }
    return { message: (error as Error).message || String(error) };
  }

  async getToken(): Promise<string> {
    const username = this.configService.get<string>('OMNIA_API_USERNAME');
    const password = this.configService.get<string>('OMNIA_API_PASSWORD');

    if (!username || !password) {
      throw new Error('Credenciais de API não configuradas');
    }

    try {
      const authResponse = await this.api.post<AuthResponse>(
        '/token',
        {},
        {
          auth: { username, password },
        },
      );

      this.logger.log('Novo token gerado com sucesso');
      return authResponse.data.token;
    } catch (error) {
      const formatted = this.formatAxiosError(error);
      this.logger.error(
        'Falha na autenticação com a API Omnia',
        JSON.stringify(formatted),
      );
      throw new Error(
        'Falha na autenticação com a API Omnia: ' + formatted.message,
      );
    }
  }

  async getClientByCpfOrCnpj(cpfOrCnpj: string): Promise<OmniClient[]> {
    if (!cpfOrCnpj) {
      throw new Error('CPF/CNPJ não informado');
    }

    try {
      const token = await this.getToken();

      const response = await this.api.get<OmniClient[]>(
        `/api/clientes/${cpfOrCnpj}/cnpjcpf`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      );

      return response.data;
    } catch (error) {
      const formatted = this.formatAxiosError(error);
      this.logger.error(
        `Erro ao buscar cliente ${cpfOrCnpj}`,
        JSON.stringify(formatted),
      );
      throw new Error(`Falha ao buscar cliente: ${formatted.message}`);
    }
  }

  async fetchAllPagesConcurrent<T>(
    endpoint: string,
    token: string,
    concurrency = 5,
    maxRetries = 3,
  ): Promise<T[]> {
    const pageSize = 1000;

    const fetchPage = async (page: number, attempt = 1): Promise<T[]> => {
      try {
        const response = await this.api.get<OmniaPaginatedResponse<T>>(
          `${endpoint}?page=${page}&pagesize=${pageSize}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        return response.data.data;
      } catch (error) {
        if (attempt <= maxRetries) {
          const delay = 1000 * attempt;
          this.logger.warn(
            `Falha ao buscar página ${page} (tentativa ${attempt}). Retentando em ${delay}ms...`,
          );
          await new Promise((res) => setTimeout(res, delay));
          return fetchPage(page, attempt + 1);
        }
        const formatted = this.formatAxiosError(error);
        this.logger.error(
          `Página ${page} falhou após ${maxRetries} tentativas.`,
          JSON.stringify(formatted),
        );
        return [];
      }
    };

    const firstResponse = await this.api.get<OmniaPaginatedResponse<T>>(
      `${endpoint}?page=1&pagesize=${pageSize}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    const totalPages = firstResponse.data.pagination.totalpages;
    const results: T[] = [...firstResponse.data.data];
    const pages = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);

    for (let i = 0; i < pages.length; i += concurrency) {
      const batch = pages.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map((page) => fetchPage(page)),
      );
      batchResults.forEach((pageData) => results.push(...pageData));
    }

    return results;
  }

  async getProducts(): Promise<OmniaProduct[]> {
    try {
      const token = await this.getToken();
      return this.fetchAllPagesConcurrent<OmniaProduct>(
        '/api/v1/produtos',
        token,
      );
    } catch (error) {
      const formatted = this.formatAxiosError(error);
      this.logger.error('Erro ao buscar produtos', JSON.stringify(formatted));
      throw new Error(`Falha ao buscar produtos: ${formatted.message}`);
    }
  }

  async getStock(): Promise<OmniaStockInterface[]> {
    try {
      const token = await this.getToken();
      this.logger.log('Buscando estoques...');
      return this.fetchAllPagesConcurrent<any>('/api/v1/estoques', token);
    } catch (error) {
      const formatted = this.formatAxiosError(error);
      this.logger.error('Erro ao buscar estoques', JSON.stringify(formatted));
      throw new Error(`Falha ao buscar estoques: ${formatted.message}`);
    }
  }

  async getPrices(): Promise<OmniaPriceInterface[]> {
    try {
      const token = await this.getToken();
      this.logger.log('Buscando preços...');
      return this.fetchAllPagesConcurrent<any>('/api/v1/precos', token);
    } catch (error) {
      const formatted = this.formatAxiosError(error);
      this.logger.error('Erro ao buscar preços', JSON.stringify(formatted));
      throw new Error(`Falha ao buscar preços: ${formatted.message}`);
    }
  }

  async getProductBySku(sku: string): Promise<{
    prices: OmniaPriceInterface[];
    stock: OmniaStockInterface[];
  }> {
    const token = await this.getToken();

    const [prices, stock] = await Promise.all([
      this.fetchAllPagesConcurrent<OmniaPriceInterface>('/api/v1/precos', token),
      this.fetchAllPagesConcurrent<OmniaStockInterface>('/api/v1/estoques', token),
    ]);

    return {
      prices: prices.filter((p) => String(p.codprod) === String(sku)),
      stock: stock.filter((s) => String(s.codprod) === String(sku)),
    };
  }

  async createClient(client: CreateOmniClientDto): Promise<any> {
    const token = await this.getToken();
    this.logger.log('Criando cliente...');

    try {
      const response = await this.api.post<OmniClient>(
        '/api/clientes',
        client,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );

      return response.data;
    } catch (error) {
      const formatted = this.formatAxiosError(error);
      this.logger.error('Erro ao criar cliente', JSON.stringify(formatted));
      throw new Error(`Falha ao criar cliente: ${formatted.message}`);
    }
  }

  async createOrder(order: any): Promise<any> {
    const token = await this.getToken();
    this.logger.log('Criando pedido...');

    try {
      const response = await this.api.post<any>('/api/pedidos', order, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return response.data;
    } catch (error) {
      const formatted = this.formatAxiosError(error);
      this.logger.error('Erro ao criar pedido', JSON.stringify(formatted));
      throw new Error(`Falha ao criar pedido: ${formatted.message}`);
    }
  }
}
