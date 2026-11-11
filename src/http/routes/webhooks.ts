import type { FastifyInstance } from 'fastify';
import { JOB_WOO_ORDER } from '../../core/processor.js';
import { verifyWooSignature } from '../../sources/woo/signature.js';
import type { AppServices } from '../services.js';

const ORDER_TOPICS = new Set(['order.created', 'order.updated']);

/**
 * POST /webhooks/woo
 * 1) verifica la firma HMAC sobre el cuerpo crudo
 * 2) encola el pedido (idempotente por pedido + estado)
 * 3) responde 200 enseguida y procesa en segundo plano
 */
export async function webhookRoutes(app: FastifyInstance, s: AppServices) {
  // Necesitamos los bytes EXACTOS para la firma: en este ámbito el cuerpo llega como Buffer.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.post('/webhooks/woo', async (req, reply) => {
    const raw = (req.body as Buffer | undefined) ?? Buffer.alloc(0);
    const contentType = req.headers['content-type'] ?? '';

    // Al guardar un webhook, WooCommerce envía un "ping" con webhook_id=N (form-urlencoded).
    if (
      contentType.includes('application/x-www-form-urlencoded') &&
      raw.toString().startsWith('webhook_id=')
    ) {
      return reply.code(200).send({ ok: true, ping: true });
    }

    const signature = req.headers['x-wc-webhook-signature'];
    if (
      !verifyWooSignature(
        raw,
        typeof signature === 'string' ? signature : undefined,
        s.settings.wooWebhookSecret,
      )
    ) {
      req.log.warn({ topic: req.headers['x-wc-webhook-topic'] }, 'firma de webhook inválida');
      return reply.code(401).send({ error: 'invalid signature' });
    }

    const topic = String(req.headers['x-wc-webhook-topic'] ?? '');
    if (!ORDER_TOPICS.has(topic)) {
      return reply.code(200).send({ ok: true, ignored: `topic ${topic}` });
    }

    let order: { id?: number; status?: string };
    try {
      order = JSON.parse(raw.toString('utf8'));
    } catch {
      return reply.code(400).send({ error: 'invalid json' });
    }
    if (typeof order.id !== 'number' || typeof order.status !== 'string') {
      return reply.code(400).send({ error: 'missing order id/status' });
    }

    if (!s.settings.syncStatuses.includes(order.status)) {
      return reply.code(200).send({ ok: true, ignored: `status ${order.status}` });
    }

    const queued = await s.queue.enqueue({
      type: JOB_WOO_ORDER,
      dedupeKey: `woo:order:${order.id}:${order.status}`,
      entityKey: `order:${order.id}`,
      payload: order,
    });

    // Procesar ya, sin hacer esperar a WooCommerce. Si falla, el cron lo reintenta.
    setImmediate(() => {
      s.processor.run(5).catch((err) => req.log.error({ err }, 'error procesando tras webhook'));
    });

    return reply.code(200).send({ ok: true, queued, duplicate: !queued });
  });
}
