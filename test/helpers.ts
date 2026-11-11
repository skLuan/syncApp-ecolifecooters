import type { Job, JobQueue, JobStatus, NewJob } from '../src/core/queue.js';
import type { Entity, IdMap, IdMapping, SyncLog } from '../src/core/store.js';

/** Cola en memoria con el mismo contrato que MysqlJobQueue. */
export class MemoryQueue implements JobQueue {
  jobs: (Job & { runAfter: number })[] = [];
  private seq = 0;

  async enqueue(job: NewJob) {
    if (this.jobs.some((j) => j.dedupeKey === job.dedupeKey)) return false;
    this.jobs.push({
      id: ++this.seq,
      type: job.type,
      dedupeKey: job.dedupeKey,
      entityKey: job.entityKey,
      payload: job.payload,
      status: 'pending',
      attempts: 0,
      lastError: null,
      runAfter: 0,
    });
    return true;
  }

  async claim(limit: number) {
    const ready = this.jobs
      .filter((j) => (j.status === 'pending' || j.status === 'failed') && j.runAfter <= Date.now())
      .slice(0, limit);
    for (const j of ready) {
      j.status = 'running';
      j.attempts += 1;
    }
    return ready.map((j) => ({ ...j }));
  }

  async complete(id: number) {
    this.byId(id).status = 'done';
  }

  async fail(id: number, error: string, opts: { retryInSeconds?: number; dead?: boolean }) {
    const j = this.byId(id);
    j.status = opts.dead ? 'dead' : 'failed';
    j.lastError = error;
    j.runAfter = Date.now() + (opts.retryInSeconds ?? 0) * 1000;
  }

  async retry(id: number) {
    const j = this.jobs.find((x) => x.id === id);
    if (!j || (j.status !== 'failed' && j.status !== 'dead')) return false;
    j.status = 'pending';
    j.attempts = 0;
    j.runAfter = 0;
    return true;
  }

  async stats() {
    const out: Record<JobStatus, number> = { pending: 0, running: 0, done: 0, failed: 0, dead: 0 };
    for (const j of this.jobs) out[j.status] += 1;
    return out;
  }

  async recent(statuses: JobStatus[], limit: number) {
    return this.jobs.filter((j) => statuses.includes(j.status)).slice(0, limit);
  }

  /** Simula que pasó el tiempo de espera de los reintentos. */
  fastForward() {
    for (const j of this.jobs) j.runAfter = 0;
  }

  byId(id: number) {
    const j = this.jobs.find((x) => x.id === id);
    if (!j) throw new Error(`job ${id} no existe`);
    return j;
  }
}

export class MemoryIdMap implements IdMap {
  data = new Map<string, IdMapping>();
  private k(e: Entity, s: string, id: string, t: string) {
    return `${e}|${s}|${id}|${t}`;
  }
  async get(e: Entity, s: string, id: string, t: string) {
    return this.data.get(this.k(e, s, id, t)) ?? null;
  }
  async set(e: Entity, s: string, id: string, t: string, m: IdMapping) {
    this.data.set(this.k(e, s, id, t), m);
  }
}

export class MemorySyncLog implements SyncLog {
  entries: { level: string; message: string; entityKey?: string }[] = [];
  async write(e: { level: 'info' | 'warn' | 'error'; message: string; entityKey?: string }) {
    this.entries.push(e);
  }
}

export const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
