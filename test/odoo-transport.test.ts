import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermanentError, RetryableError } from '../src/core/errors.js';
import { Json2Transport, JsonRpcTransport } from '../src/targets/odoo/transport.js';

const conn = { url: 'https://demo.odoo.com/', db: 'demo', login: 'api@demo.com', apiKey: 'KEY' };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('Json2Transport (Odoo 19+)', () => {
  it('llama /json/2/{model}/{method} con bearer, base de datos e ids', async () => {
    const fetchMock = vi.fn(async () => json([1]));
    vi.stubGlobal('fetch', fetchMock);
    await new Json2Transport(conn).call('sale.order', 'action_confirm', {}, [5]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://demo.odoo.com/json/2/sale.order/action_confirm');
    expect(init.headers).toMatchObject({ Authorization: 'bearer KEY', 'X-Odoo-Database': 'demo' });
    expect(JSON.parse(String(init.body))).toEqual({ ids: [5] });
  });

  it('clasifica errores: credenciales y validación = permanente, 5xx = reintento', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({}, 401)),
    );
    await expect(new Json2Transport(conn).call('x', 'y')).rejects.toThrow(PermanentError);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ name: 'odoo.exceptions.ValidationError', message: 'no' }, 422)),
    );
    await expect(new Json2Transport(conn).call('x', 'y')).rejects.toThrow(PermanentError);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Bad gateway', { status: 502 })),
    );
    await expect(new Json2Transport(conn).call('x', 'y')).rejects.toThrow(RetryableError);
  });
});

describe('JsonRpcTransport (Odoo ≤ 18)', () => {
  it('autentica una vez y usa execute_kw con parámetros nombrados', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ jsonrpc: '2.0', id: 1, result: 7 }))
      .mockImplementation(async () => json({ jsonrpc: '2.0', id: 2, result: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const t = new JsonRpcTransport(conn);
    await t.call('res.partner', 'search_read', { domain: [], fields: ['id'] });
    await t.call('sale.order', 'read', { fields: ['amount_total'] }, [3]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const auth = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(auth.params).toEqual({
      service: 'common',
      method: 'authenticate',
      args: ['demo', 'api@demo.com', 'KEY', {}],
    });
    const read = JSON.parse(String((fetchMock.mock.calls[2] as [string, RequestInit])[1].body));
    expect(read.params.args).toEqual([
      'demo',
      7,
      'KEY',
      'sale.order',
      'read',
      [[3]],
      { fields: ['amount_total'] },
    ]);
  });

  it('falla de forma permanente si authenticate devuelve false', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ jsonrpc: '2.0', id: 1, result: false })),
    );
    await expect(new JsonRpcTransport(conn).call('x', 'y')).rejects.toThrow(/rechazó/);
  });
});
