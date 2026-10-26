import { readdir, readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

import pg from 'pg';

export interface Queryable {
  /** Runs one parameterized statement and returns its rows. */
  query<Row>(sql: string, params?: unknown[]): Promise<Row[]>;
}

export interface Transaction extends Queryable {
  /** Runs a script of several statements without parameters, such as a migration file. */
  exec(sql: string): Promise<void>;
}

export interface Database extends Queryable {
  /** Runs `work` in one transaction, committing when it resolves and rolling back when it throws. */
  transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
  /**
   * Calls onNotification with the payload of every NOTIFY on `channel` until close. Throws when the
   * first LISTEN fails. A dropped connection is reopened; notifications sent while it is down are lost.
   */
  listen(channel: string, onNotification: (payload: string) => void): Promise<void>;
  close(): Promise<void>;
}

const LISTEN_RETRY_MS = 5000;

export interface PostgresSettings {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/** Opens a connection pool to PostgreSQL. Connections are made lazily, on the first query. */
export function createPostgresDatabase(settings: PostgresSettings): Database {
  const pool = new pg.Pool({ ...settings, max: 10, connectionTimeoutMillis: 5000 });
  // An idle client that loses its connection emits on the pool; without a listener the process exits.
  pool.on('error', (error) => {
    console.error(JSON.stringify({ event: 'database_error', message: error.message }));
  });

  // LISTEN needs a connection of its own for as long as it lasts, so listeners are not pool clients.
  const listeners = new Set<pg.Client>();
  let closing = false;

  const subscribe = async (channel: string, onNotification: (payload: string) => void): Promise<void> => {
    const client = new pg.Client({ ...settings, connectionTimeoutMillis: 5000 });
    // Without an error listener a lost connection would exit the process. It also emits 'end', below.
    client.on('error', (error) => {
      console.error(JSON.stringify({ event: 'database_listen_error', channel, message: error.message }));
    });
    client.on('notification', (message) => onNotification(message.payload ?? ''));
    try {
      await client.connect();
      await client.query(`LISTEN ${client.escapeIdentifier(channel)}`);
    } catch (error) {
      await client.end().catch(() => undefined);
      throw error;
    }
    listeners.add(client);
    client.once('end', () => {
      listeners.delete(client);
      if (!closing) void resubscribe(channel, onNotification);
    });
  };
  const resubscribe = async (channel: string, onNotification: (payload: string) => void): Promise<void> => {
    while (!closing) {
      // Unreferenced, so a pending retry does not keep a stopping process alive.
      await sleep(LISTEN_RETRY_MS, undefined, { ref: false });
      if (closing) return;
      try {
        await subscribe(channel, onNotification);
        return;
      } catch (error) {
        console.error(
          JSON.stringify({ event: 'database_listen_failed', channel, message: (error as Error).message }),
        );
      }
    }
  };

  return {
    async query<Row>(sql: string, params?: unknown[]) {
      return (await pool.query(sql, params)).rows as Row[];
    },
    async transaction<T>(work: (tx: Transaction) => Promise<T>) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work({
          query: async <Row>(sql: string, params?: unknown[]) =>
            (await client.query(sql, params)).rows as Row[],
          exec: async (sql: string) => {
            await client.query(sql);
          },
        });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    listen: subscribe,
    async close() {
      closing = true;
      await Promise.all([...listeners].map((client) => client.end()));
      await pool.end();
    },
  };
}

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
// Any constant works, as long as every gateway process uses the same one.
const MIGRATION_LOCK_ID = 7_382_401;

/**
 * Applies the migration files that have not run yet, in file-name order, in one transaction, and
 * returns their names. An advisory lock makes gateways that start together wait instead of racing.
 */
export async function migrate(db: Database): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith('.sql')).sort();
  return db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_ID]);
    await tx.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const applied = await tx.query<{ name: string }>('SELECT name FROM schema_migrations');
    const pending = files.filter((file) => !applied.some((row) => row.name === file));
    for (const file of pending) {
      await tx.exec(await readFile(new URL(file, MIGRATIONS_DIR), 'utf8'));
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    }
    return pending;
  });
}

const DATABASE_WAIT_ATTEMPTS = 30;
const DATABASE_WAIT_DELAY_MS = 2000;

/**
 * Waits up to a minute for the database to answer, so a gateway that starts before PostgreSQL does
 * not crash-loop. Throws the last connection error after that.
 */
export async function waitForDatabase(db: Database): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await db.query('SELECT 1');
      return;
    } catch (error) {
      if (attempt >= DATABASE_WAIT_ATTEMPTS) throw error;
      console.error(
        JSON.stringify({ event: 'database_unavailable', attempt, message: (error as Error).message }),
      );
      await new Promise((resolve) => setTimeout(resolve, DATABASE_WAIT_DELAY_MS));
    }
  }
}
