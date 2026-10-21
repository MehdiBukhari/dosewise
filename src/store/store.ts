import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Database } from '../domain/types.js';

function emptyDatabase(): Database {
  return {
    household: { id: 'hh-1', patientId: 'ruth', caregiverIds: ['dana'], timezone: 'America/Los_Angeles' },
    people: [],
    prescribers: [],
    medications: [],
    doseLogs: [],
    outbox: [],
    confirmations: [],
    audit: [],
  };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

/**
 * Tiny JSON-file store.
 *
 * Every mutation is serialised through one promise chain and persisted with a
 * write-then-rename, so concurrent MCP tool calls cannot interleave a read and
 * a write or leave a half-written file behind.
 */
export class Store {
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly file: string,
    private state: Database,
  ) {}

  static async open(file: string, seed: (db: Database) => void | Promise<void>): Promise<Store> {
    await mkdir(path.dirname(file), { recursive: true });
    let state: Database;
    try {
      state = JSON.parse(await readFile(file, 'utf8')) as Database;
    } catch {
      state = emptyDatabase();
      await seed(state);
      const store = new Store(file, state);
      await store.persist();
      return store;
    }
    return new Store(file, state);
  }

  read<T>(reader: (db: Database) => T): T {
    return reader(this.state);
  }

  mutate<T>(mutator: (db: Database) => T | Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const result = await mutator(this.state);
      await this.persist();
      return result;
    });
    // Keep the chain alive even if this mutation rejects.
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async persist(): Promise<void> {
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    await rename(temporary, this.file);
  }
}
