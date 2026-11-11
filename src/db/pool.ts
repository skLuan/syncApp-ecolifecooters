import mysql, { type Pool } from 'mysql2/promise';
import type { Config } from '../config.js';

export type Db = Pool;

export function createPool(config: Config): Db {
  return mysql.createPool({
    host: config.DB_HOST,
    port: config.DB_PORT,
    user: config.DB_USER,
    password: config.DB_PASSWORD,
    database: config.DB_NAME,
    // Hosting compartido: pocas conexiones.
    connectionLimit: 5,
    waitForConnections: true,
    // Fechas en UTC para que run_after / locked_until sean coherentes.
    timezone: 'Z',
    dateStrings: false,
    charset: 'utf8mb4',
  });
}

export async function pingDb(db: Db): Promise<boolean> {
  try {
    await db.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
