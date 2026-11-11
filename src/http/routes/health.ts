import type { FastifyInstance } from 'fastify';
import type { AppServices } from '../services.js';

export async function healthRoutes(app: FastifyInstance, s: AppServices) {
  app.get('/health', async (_req, reply) => {
    const db = await s.pingDb();
    return reply.code(db ? 200 : 503).send({
      ok: db,
      db,
      target: s.settings.targetName,
      version: s.settings.version,
      time: new Date().toISOString(),
    });
  });
}
