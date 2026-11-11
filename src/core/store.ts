import type { RowDataPacket } from 'mysql2';
import type { Db } from '../db/pool.js';

export type Entity = 'order' | 'customer' | 'product';

export interface IdMapping {
  targetId: string;
  extra?: Record<string, unknown>;
}

/** Relación ID origen ↔ ID destino. */
export interface IdMap {
  get(entity: Entity, source: string, sourceId: string, target: string): Promise<IdMapping | null>;
  set(
    entity: Entity,
    source: string,
    sourceId: string,
    target: string,
    mapping: IdMapping,
  ): Promise<void>;
}

export type LogLevel = 'info' | 'warn' | 'error';

export interface SyncLog {
  write(entry: {
    jobId?: number;
    entityKey?: string;
    level: LogLevel;
    message: string;
  }): Promise<void>;
}

/** Estado clave/valor (cursores de sincronización). */
export interface StateStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export class MysqlIdMap implements IdMap {
  constructor(private readonly db: Db) {}

  async get(entity: Entity, source: string, sourceId: string, target: string) {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      `SELECT target_id, extra FROM id_map
       WHERE entity = ? AND source = ? AND source_id = ? AND target = ?`,
      [entity, source, sourceId, target],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      targetId: String(row.target_id),
      extra: row.extra ? (JSON.parse(row.extra) as Record<string, unknown>) : undefined,
    };
  }

  async set(entity: Entity, source: string, sourceId: string, target: string, mapping: IdMapping) {
    await this.db.execute(
      `INSERT INTO id_map (entity, source, source_id, target, target_id, extra)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE target_id = VALUES(target_id), extra = VALUES(extra)`,
      [
        entity,
        source,
        sourceId,
        target,
        mapping.targetId,
        mapping.extra ? JSON.stringify(mapping.extra) : null,
      ],
    );
  }
}

export class MysqlSyncLog implements SyncLog {
  constructor(private readonly db: Db) {}

  async write(entry: { jobId?: number; entityKey?: string; level: LogLevel; message: string }) {
    await this.db.execute(
      'INSERT INTO sync_log (job_id, entity_key, level, message) VALUES (?, ?, ?, ?)',
      [entry.jobId ?? null, entry.entityKey ?? null, entry.level, entry.message.slice(0, 60_000)],
    );
  }
}

export class MysqlStateStore implements StateStore {
  constructor(private readonly db: Db) {}

  async get(key: string) {
    const [rows] = await this.db.execute<RowDataPacket[]>(
      'SELECT `value` FROM sync_state WHERE `key` = ?',
      [key],
    );
    return rows[0] ? String(rows[0].value) : null;
  }

  async set(key: string, value: string) {
    await this.db.execute(
      'INSERT INTO sync_state (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)',
      [key, value],
    );
  }
}
