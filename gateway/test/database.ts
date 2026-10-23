import { PGlite } from '@electric-sql/pglite';

import { migrate } from '../src/db.js';
import type { Database, Transaction } from '../src/db.js';

/**
 * A migrated in-process PostgreSQL (PGlite) behind the gateway's Database interface, so tests run the
 * real SQL without a server.
 */
export async function createTestDatabase(): Promise<Database> {
  const pglite = new PGlite();
  const db: Database = {
    async query<Row>(sql: string, params?: unknown[]) {
      return (await pglite.query<Row>(sql, params)).rows;
    },
    transaction: <T>(work: (tx: Transaction) => Promise<T>) =>
      pglite.transaction((tx) =>
        work({
          query: async <Row>(sql: string, params?: unknown[]) => (await tx.query<Row>(sql, params)).rows,
          exec: async (sql: string) => {
            await tx.exec(sql);
          },
        }),
      ),
    close: () => pglite.close(),
  };
  await migrate(db);
  return db;
}
