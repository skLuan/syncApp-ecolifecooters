import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AppServices } from '../src/http/services.js';
import { signWooPayload } from '../src/sources/woo/signature.js';
import fixture from './fixtures/woo-order.json' with { type: 'json' };
import { MemoryQueue } from './helpers.js';

const SECRET = 'webhook-secret';
const JOBS_TOKEN = 'jobs-token-1234567890';

function makeApp() {
  const queue = new MemoryQueue();
  const processor = { run: vi.fn(async () => ({ claimed: 0, done: 0, retried: 0, dead: 0 })) };
  const services: AppServices = {
    settings: {
      jobsToken: JOBS_TOKEN,
      adminToken: 'admin-token-1234567890',
      wooWebhookSecret: SECRET,
      syncStatuses: ['processing', 'completed'],
      version: 'test',
      targetName: 'odoo',
    },
    queue,
    processor,
    stockSync: null,
    pingDb: async () => true,
  };
  return { app: buildApp(services), queue, processor };
}

function post(
  app: ReturnType<typeof makeApp>['app'],
  body: object,
  opts: { signature?: string; topic?: string } = {},
) {
  const payload = JSON.stringify(body);
  return app.inject({
    method: 'POST',
    url: '/webhooks/woo',
    headers: {
      'content-type': 'application/json',
      'x-wc-webhook-topic': opts.topic ?? 'order.updated',
      'x-wc-webhook-signature': opts.signature ?? signWooPayload(payload, SECRET),
    },
    payload,
  });
}

describe('POST /webhooks/woo', () => {
  it('encola un pedido pagado con firma válida', async () => {
    const { app, queue } = makeApp();
    const res = await post(app, fixture);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ queued: true });
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]?.dedupeKey).toBe('woo:order:4521:processing');
  });

  it('rechaza firmas inválidas sin crear jobs', async () => {
    const { app, queue } = makeApp();
    const res = await post(app, fixture, { signature: 'falsa' });
    expect(res.statusCode).toBe(401);
    expect(queue.jobs).toHaveLength(0);
  });

  it('no duplica el mismo pedido en el mismo estado', async () => {
    const { app, queue } = makeApp();
    await post(app, fixture);
    const res = await post(app, fixture);
    expect(res.json()).toMatchObject({ queued: false, duplicate: true });
    expect(queue.jobs).toHaveLength(1);
  });

  it('ignora estados no configurados (ej. pending) y topics que no son de pedidos', async () => {
    const { app, queue } = makeApp();
    expect((await post(app, { ...fixture, status: 'pending' })).json()).toMatchObject({
      ignored: 'status pending',
    });
    expect((await post(app, fixture, { topic: 'product.updated' })).statusCode).toBe(200);
    expect(queue.jobs).toHaveLength(0);
  });

  it('responde 200 al ping de WooCommerce al crear el webhook', async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/woo',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'webhook_id=12',
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('rutas protegidas', () => {
  it('/jobs/run exige token', async () => {
    const { app, processor } = makeApp();
    expect((await app.inject({ method: 'POST', url: '/jobs/run' })).statusCode).toBe(401);
    const ok = await app.inject({
      method: 'POST',
      url: '/jobs/run',
      headers: { authorization: `Bearer ${JOBS_TOKEN}` },
    });
    expect(ok.statusCode).toBe(200);
    expect(processor.run).toHaveBeenCalled();
  });

  it('/health responde sin token', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, db: true });
  });
});
