import { loadConfig } from '../config.js';
import { runMigrations } from './migrate.js';

const config = loadConfig();
runMigrations(config)
  .then((ran) => {
    console.log(
      ran.length ? `Migraciones aplicadas: ${ran.join(', ')}` : 'Sin migraciones pendientes',
    );
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
