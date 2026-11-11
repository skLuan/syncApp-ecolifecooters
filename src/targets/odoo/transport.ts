import { PermanentError, RetryableError } from '../../core/errors.js';

/**
 * Odoo tiene dos APIs externas:
 *  - JSON-2  (Odoo 19+):  POST /json/2/{model}/{method}  con "Authorization: bearer <api key>"
 *  - JSON-RPC (≤ 18, en retirada): POST /jsonrpc  con execute_kw(db, uid, api_key, ...)
 * El adaptador usa siempre `call(model, method, params, ids?)` con parámetros NOMBRADOS,
 * y cada transporte lo traduce. Se elige con ODOO_API=json2|jsonrpc.
 */
export interface OdooTransport {
  call<T = unknown>(
    model: string,
    method: string,
    params?: Record<string, unknown>,
    ids?: number[],
  ): Promise<T>;
}

export interface OdooConnection {
  url: string;
  db: string;
  login: string;
  apiKey: string;
  timeoutMs?: number;
}

/** Errores de negocio de Odoo: reintentar no los arregla. */
const PERMANENT_ODOO_ERRORS = [
  'ValidationError',
  'UserError',
  'AccessError',
  'AccessDenied',
  'MissingError',
  'ValueError',
  'KeyError',
  'TypeError',
];

function classify(name: string | undefined, message: string): Error {
  const short = (name ?? '').split('.').pop() ?? '';
  const text = `Odoo ${short || 'error'}: ${message}`;
  return PERMANENT_ODOO_ERRORS.includes(short)
    ? new PermanentError(text)
    : new RetryableError(text);
}

async function post(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await fetch(url, { ...init, method: 'POST', signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new RetryableError(`Odoo no responde (${url}): ${String(err)}`);
  }
}

export class Json2Transport implements OdooTransport {
  private readonly base: string;

  constructor(private readonly conn: OdooConnection) {
    this.base = conn.url.replace(/\/$/, '');
  }

  async call<T>(
    model: string,
    method: string,
    params: Record<string, unknown> = {},
    ids?: number[],
  ) {
    const body = ids ? { ids, ...params } : params;
    const res = await post(
      `${this.base}/json/2/${model}/${method}`,
      {
        headers: {
          Authorization: `bearer ${this.conn.apiKey}`,
          'X-Odoo-Database': this.conn.db,
          'Content-Type': 'application/json; charset=utf-8',
          'User-Agent': 'ecolife-sync',
        },
        body: JSON.stringify(body),
      },
      this.conn.timeoutMs ?? 30_000,
    );
    const text = await res.text();
    if (res.ok) return (text ? JSON.parse(text) : null) as T;

    let name: string | undefined;
    let message = text.slice(0, 500);
    try {
      const err = JSON.parse(text) as { name?: string; message?: string };
      name = err.name;
      message = err.message ?? message;
    } catch {
      /* respuesta no JSON */
    }
    if (res.status === 401 || res.status === 403) {
      throw new PermanentError(`Odoo rechazó las credenciales (${res.status}): ${message}`);
    }
    if (res.status >= 500 && !name) throw new RetryableError(`Odoo ${res.status}: ${message}`);
    if (res.status === 429) throw new RetryableError(`Odoo limitó las peticiones (429)`);
    if (res.status === 404) {
      throw new PermanentError(
        `Odoo 404 en /json/2/${model}/${method}. ¿La versión es anterior a la 19? Prueba ODOO_API=jsonrpc`,
      );
    }
    throw classify(name, message);
  }
}

export class JsonRpcTransport implements OdooTransport {
  private readonly endpoint: string;
  private uid: number | null = null;
  private seq = 0;

  constructor(private readonly conn: OdooConnection) {
    this.endpoint = `${conn.url.replace(/\/$/, '')}/jsonrpc`;
  }

  private async rpc<T>(service: string, method: string, args: unknown[]): Promise<T> {
    const res = await post(
      this.endpoint,
      {
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'ecolife-sync' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'call',
          params: { service, method, args },
          id: ++this.seq,
        }),
      },
      this.conn.timeoutMs ?? 30_000,
    );
    if (res.status >= 500) throw new RetryableError(`Odoo ${res.status}`);
    const json = (await res.json()) as {
      result?: T;
      error?: { message: string; data?: { name?: string; message?: string } };
    };
    if (json.error) {
      throw classify(json.error.data?.name, json.error.data?.message ?? json.error.message);
    }
    return json.result as T;
  }

  private async getUid(): Promise<number> {
    if (this.uid) return this.uid;
    const uid = await this.rpc<number | false>('common', 'authenticate', [
      this.conn.db,
      this.conn.login,
      this.conn.apiKey,
      {},
    ]);
    if (!uid) throw new PermanentError('Odoo rechazó el usuario o la API key (authenticate)');
    this.uid = uid;
    return uid;
  }

  async call<T>(
    model: string,
    method: string,
    params: Record<string, unknown> = {},
    ids?: number[],
  ) {
    const uid = await this.getUid();
    return this.rpc<T>('object', 'execute_kw', [
      this.conn.db,
      uid,
      this.conn.apiKey,
      model,
      method,
      ids ? [ids] : [],
      params,
    ]);
  }
}

export function createTransport(kind: 'json2' | 'jsonrpc', conn: OdooConnection): OdooTransport {
  return kind === 'json2' ? new Json2Transport(conn) : new JsonRpcTransport(conn);
}
