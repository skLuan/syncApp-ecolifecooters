import { randomUUID } from 'node:crypto';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import type { Db } from '../db/pool.js';

export type JobStatus = 'pending' | 'running' | 'done' | 'failed' | 'dead';

export interface Job<T = unknown> {
  id: number;
  type: string;
  dedupeKey: string;
  entityKey: string;
  payload: T;
  status: JobStatus;
  attempts: number;
  lastError: string | null;
}

export interface NewJob {
  type: string;
  dedupeKey: string;
  entityKey: string;
  payload: unknown;
}

export interface JobQueue {
  /** Devuelve false si ya existía un job con el mismo dedupeKey. */
  enqueue(job: NewJob): Promise<boolean>;
  /** Reserva hasta `limit` jobs listos. Seguro ante ejecuciones simultáneas. */
  claim(limit: number): Promise<Job[]>;
  complete(id: number): Promise<void>;
  /** Programa reintento o marca como "dead" si `dead` es true. */
  fail(id: number, error: string, opts: { retryInSeconds?: number; dead?: boolean }): Promise<void>;
  /** Vuelve a poner un job (fallido o dead) en la cola. */
  retry(id: number): Promise<boolean>;
  stats(): Promise<Record<JobStatus, number>>;
  recent(statuses: JobStatus[], limit: number): Promise<Job[]>;
}

/** Espera antes del siguiente intento: 5 min, 15 min, 1 h, 3 h, 6 h… */
export function backoffSeconds(attempt: number): number {
  const steps = [5 * 60, 15 * 60, 60 * 60, 3 * 60 * 60, 6 * 60 * 60];
  return steps[Math.min(Math.max(attempt, 1), steps.length) - 1] ?? 6 * 60 * 60;
}

/** Cuánto dura la reserva de un job antes de considerarse abandonada. */
const LOCK_SECONDS = 5 * 60;

interface JobRow extends RowDataPacket {
  id: number;
  type: string;
  dedupe_key: string;
  entity_key: string;
  payload: string;
  status: JobStatus;
  attempts: number;
  last_error: string | null;
}

function toJob(row: JobRow): Job {
  return {
    id: Number(row.id),
    type: row.type,
    dedupeKey: row.dedupe_key,
    entityKey: row.entity_key,
    payload: JSON.parse(row.payload),
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
  };
}

/**
 * Cola sobre MySQL/MariaDB. No usa SKIP LOCKED para ser compatible con cualquier
 * versión: reserva con un UPDATE atómico marcado con un token único.
 */
export class MysqlJobQueue implements JobQueue {
  constructor(private readonly db: Db) {}

  async enqueue(job: NewJob): Promise<boolean> {
    const [res] = await this.db.execute<ResultSetHeader>(
      `INSERT IGNORE INTO sync_jobs (type, dedupe_key, entity_key, payload)
       VALUES (?, ?, ?, ?)`,
      [job.type, job.dedupeKey, job.entityKey, JSON.stringify(job.payload)],
    );
    return res.affectedRows === 1;
  }

  async claim(limit: number): Promise<Job[]> {
    const token = randomUUID();
    // LIMIT con placeholder no siempre funciona en execute(); se valida y se interpola.
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    await this.db.query(
      `UPDATE sync_jobs
         SET status = 'running', locked_by = ?, locked_until = UTC_TIMESTAMP() + INTERVAL ${LOCK_SECONDS} SECOND,
             attempts = attempts + 1
       WHERE (
               status IN ('pending', 'failed') AND run_after <= UTC_TIMESTAMP()
             )
          OR (
               status = 'running' AND locked_until < UTC_TIMESTAMP()
             )
       ORDER BY id
       LIMIT ${safeLimit}`,
      [token],
    );
    const [rows] = await this.db.query<JobRow[]>(
      'SELECT * FROM sync_jobs WHERE locked_by = ? AND status = ? ORDER BY id',
      [token, 'running'],
    );
    return rows.map(toJob);
  }

  async complete(id: number): Promise<void> {
    await this.db.execute(
      `UPDATE sync_jobs SET status = 'done', locked_by = NULL, locked_until = NULL, last_error = NULL
       WHERE id = ?`,
      [id],
    );
  }

  async fail(
    id: number,
    error: string,
    opts: { retryInSeconds?: number; dead?: boolean },
  ): Promise<void> {
    const status: JobStatus = opts.dead ? 'dead' : 'failed';
    const delay = Math.max(0, Math.floor(opts.retryInSeconds ?? 0));
    await this.db.execute(
      `UPDATE sync_jobs
         SET status = ?, last_error = ?, locked_by = NULL, locked_until = NULL,
             run_after = UTC_TIMESTAMP() + INTERVAL ${delay} SECOND
       WHERE id = ?`,
      [status, error.slice(0, 60_000), id],
    );
  }

  async retry(id: number): Promise<boolean> {
    const [res] = await this.db.execute<ResultSetHeader>(
      `UPDATE sync_jobs
         SET status = 'pending', attempts = 0, run_after = UTC_TIMESTAMP(), locked_by = NULL, locked_until = NULL
       WHERE id = ? AND status IN ('failed', 'dead')`,
      [id],
    );
    return res.affectedRows === 1;
  }

  async stats(): Promise<Record<JobStatus, number>> {
    const [rows] = await this.db.query<RowDataPacket[]>(
      'SELECT status, COUNT(*) AS n FROM sync_jobs GROUP BY status',
    );
    const out: Record<JobStatus, number> = { pending: 0, running: 0, done: 0, failed: 0, dead: 0 };
    for (const r of rows) out[r.status as JobStatus] = Number(r.n);
    return out;
  }

  async recent(statuses: JobStatus[], limit: number): Promise<Job[]> {
    if (statuses.length === 0) return [];
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    const [rows] = await this.db.query<JobRow[]>(
      `SELECT * FROM sync_jobs WHERE status IN (?) ORDER BY updated_at DESC LIMIT ${safeLimit}`,
      [statuses],
    );
    return rows.map(toJob);
  }
}
