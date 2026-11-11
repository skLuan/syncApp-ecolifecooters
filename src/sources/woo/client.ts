import { PermanentError, RetryableError } from '../../core/errors.js';

export interface WooClientOptions {
  baseUrl: string;
  consumerKey: string;
  consumerSecret: string;
  timeoutMs?: number;
}

export interface WooProductRef {
  id: number;
  /** 0 si es producto simple; id del padre si es una variación */
  parentId: number;
}

/** Cliente mínimo de la REST API v3 de WooCommerce (auth básica sobre HTTPS). */
export class WooClient {
  private readonly auth: string;
  private readonly base: string;

  constructor(private readonly opts: WooClientOptions) {
    this.auth = `Basic ${Buffer.from(`${opts.consumerKey}:${opts.consumerSecret}`).toString('base64')}`;
    this.base = `${opts.baseUrl.replace(/\/$/, '')}/wp-json/wc/v3`;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          Authorization: this.auth,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
      });
    } catch (err) {
      throw new RetryableError(`WooCommerce no responde (${method} ${path}): ${String(err)}`);
    }
    const text = await res.text();
    if (res.status >= 500 || res.status === 429) {
      throw new RetryableError(
        `WooCommerce ${res.status} en ${method} ${path}: ${text.slice(0, 300)}`,
      );
    }
    if (!res.ok) {
      throw new PermanentError(
        `WooCommerce ${res.status} en ${method} ${path}: ${text.slice(0, 300)}`,
      );
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  getOrder(id: string) {
    return this.request<unknown>('GET', `/orders/${encodeURIComponent(id)}`);
  }

  /** Guarda el ID del destino en el pedido de WooCommerce (visible en "Campos personalizados"). */
  async setOrderMeta(orderId: string, key: string, value: string): Promise<void> {
    await this.request('PUT', `/orders/${encodeURIComponent(orderId)}`, {
      meta_data: [{ key, value }],
    });
  }

  /**
   * Busca un producto o variación por SKU.
   * TODO(subtarea 9): validar en la tienda real que /products?sku= devuelve también variaciones.
   * Si no, construir un índice SKU→id recorriendo /products y /products/{id}/variations.
   */
  async findProductBySku(sku: string): Promise<WooProductRef | null> {
    const list = await this.request<{ id: number; parent_id?: number }[]>(
      'GET',
      `/products?sku=${encodeURIComponent(sku)}&per_page=1`,
    );
    const p = list[0];
    return p ? { id: p.id, parentId: p.parent_id ?? 0 } : null;
  }

  /** Actualiza stock de varios productos simples (máx. 100 por llamada). */
  async updateSimpleStock(items: { id: number; stock: number }[]): Promise<void> {
    if (items.length === 0) return;
    await this.request('POST', '/products/batch', {
      update: items.map((i) => ({ id: i.id, manage_stock: true, stock_quantity: i.stock })),
    });
  }

  /** Actualiza stock de variaciones de un mismo producto padre. */
  async updateVariationStock(
    parentId: number,
    items: { id: number; stock: number }[],
  ): Promise<void> {
    if (items.length === 0) return;
    await this.request('POST', `/products/${parentId}/variations/batch`, {
      update: items.map((i) => ({ id: i.id, manage_stock: true, stock_quantity: i.stock })),
    });
  }
}
