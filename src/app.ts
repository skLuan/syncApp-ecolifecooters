import Fastify, { type FastifyServerOptions } from 'fastify';
import { healthRoutes } from './http/routes/health.js';
import { jobRoutes } from './http/routes/jobs.js';
import { webhookRoutes } from './http/routes/webhooks.js';
import type { AppServices } from './http/services.js';

export function buildApp(services: AppServices, opts: FastifyServerOptions = {}) {
  const app = Fastify({
    bodyLimit: 2 * 1024 * 1024,
    // Detrás del proxy de Hostinger: confiar en X-Forwarded-For para la IP real.
    trustProxy: true,
    ...opts,
  });

  app.register(async (scope) => healthRoutes(scope, services));
  app.register(async (scope) => jobRoutes(scope, services));
  // Ámbito propio: este plugin cambia el parser de cuerpos a Buffer.
  app.register(async (scope) => webhookRoutes(scope, services));

  app.setErrorHandler((err, req, reply) => {
    req.log.error({ err }, 'error no controlado');
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    reply.code(status).send({ error: status < 500 ? (err as Error).message : 'internal error' });
  });

  return app;
}
