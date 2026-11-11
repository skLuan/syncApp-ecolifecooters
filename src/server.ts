import { pino } from 'pino';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createServices } from './container.js';
import { runMigrations } from './db/migrate.js';

/**
 * Punto de entrada. En Hostinger: entry file = dist/server.js
 * Recuerda: Hostinger detiene la app tras un rato sin tráfico. No hay timers en
 * segundo plano: todo lo dispara un webhook o el cron de hPanel (/jobs/run).
 */
async function main() {
  const config = loadConfig();

  const log = pino({
    level: config.LOG_LEVEL,
    // Nunca escribir tokens ni firmas en los logs.
    redact: ['req.headers.authorization', 'req.headers["x-wc-webhook-signature"]'],
  });

  if (config.RUN_MIGRATIONS_ON_START) {
    const ran = await runMigrations(config, { info: (m) => log.info(m) });
    if (ran.length) log.info({ ran }, 'migraciones aplicadas');
  }

  const { services, db } = createServices(config, log);
  const app = buildApp(services, { loggerInstance: log });

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'cerrando');
    await app.close();
    await db.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  log.info(
    { port: config.PORT, target: config.TARGET, api: config.ODOO_API },
    'ecolife-sync listo',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
