import type { FastifyInstance } from 'fastify';
import { requireBearer } from '../auth.js';
import type { AppServices } from '../services.js';

export async function jobRoutes(app: FastifyInstance, s: AppServices) {
  /**
   * POST /jobs/run — lo llama el cron de hPanel cada 5 min.
   * Procesa la cola (reintentos incluidos) y, si está activo, el stock.
   */
  app.post('/jobs/run', { preHandler: requireBearer(s.settings.jobsToken) }, async () => {
    const orders = await s.processor.run();
    const stock = s.stockSync ? await s.stockSync() : { skipped: 'STOCK_SYNC_ENABLED=false' };
    return { ok: true, orders, stock };
  });

  /** GET /status — panel de estado en JSON (ADMIN_TOKEN). */
  app.get('/status', { preHandler: requireBearer(s.settings.adminToken) }, async () => {
    const [counts, problems] = await Promise.all([
      s.queue.stats(),
      s.queue.recent(['failed', 'dead'], 50),
    ]);
    return {
      counts,
      problems: problems.map((j) => ({
        id: j.id,
        entity: j.entityKey,
        status: j.status,
        attempts: j.attempts,
        error: j.lastError,
      })),
    };
  });

  /** POST /jobs/:id/retry — reintento manual de un job fallido o muerto (ADMIN_TOKEN). */
  app.post<{ Params: { id: string } }>(
    '/jobs/:id/retry',
    { preHandler: requireBearer(s.settings.adminToken) },
    async (req, reply) => {
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return reply.code(400).send({ error: 'invalid id' });
      const ok = await s.queue.retry(id);
      return reply.code(ok ? 200 : 404).send({ ok });
    },
  );
}
