import { announceChange } from './changes.js';
import type { Database, Queryable } from './db.js';

export type StoreStatus = 'provisioning' | 'ready' | 'failed' | 'deleting';

/** A provisioned store as the dashboard API shows it. */
export interface Store {
  id: string;
  slug: string;
  name: string;
  url: string;
  ownerId: string;
  ownerName: string;
  status: StoreStatus;
  /** Why the store failed, for its owner to read. Never holds credentials or internal URLs. */
  reason: string | null;
  createdAt: Date;
}

/** A store row as the provisioner works with it. */
export interface StoreTask {
  id: string;
  slug: string;
  name: string;
  url: string;
  status: 'provisioning' | 'deleting';
  attempt: number;
  attemptStartedAt: Date;
}

/** Store slugs are DNS labels: they name the namespace store-<slug>, the store's host and its upstream. */
export const STORE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,14}[a-z0-9]$/;

const STORE_COLUMNS = `s.id, s.slug, s.name, s.url, s.owner_id AS "ownerId", m.name AS "ownerName", s.status,
  s.reason, s.created_at AS "createdAt"`;
const STORE_FROM = 'stores s JOIN members m ON m.id = s.owner_id';

/** The namespace a store's release is installed in. */
export function storeNamespace(slug: string): string {
  return `store-${slug}`;
}

/** The storefront URL of a store, such as http://store-delhi.localtest.me for domain localtest.me. */
export function storeUrl(slug: string, domain: string, protocol: string): string {
  return `${protocol}//store-${slug}.${domain}`;
}

/** The in-cluster address of a store's woo-mcp, which the gateway registers as its upstream. */
export function storeMcpUrl(slug: string): string {
  return `http://woo-mcp.${storeNamespace(slug)}.svc.cluster.local:3000/mcp`;
}

export async function listStores(db: Queryable): Promise<Store[]> {
  return db.query<Store>(`SELECT ${STORE_COLUMNS} FROM ${STORE_FROM} ORDER BY s.created_at`);
}

export async function getStore(db: Queryable, id: string): Promise<Store | undefined> {
  const [store] = await db.query<Store>(`SELECT ${STORE_COLUMNS} FROM ${STORE_FROM} WHERE s.id = $1`, [id]);
  return store;
}

export type CreateStoreRefusal = 'limit_reached' | 'slug_taken' | 'being_deleted';

/**
 * Records a store for the provisioner to create. Repeating the request for a store the owner already
 * has returns that store with `created: false`, so a retried request does not start a second one.
 * Refuses when the slug belongs to another member's store, an upstream or a hosted server, while the owner's store of
 * that slug is still being deleted, and when the owner already has `maxPerMember` stores.
 */
export async function createStore(
  db: Database,
  input: { slug: string; name: string; url: string; ownerId: string; maxPerMember: number },
): Promise<{ store: Store; created: boolean } | CreateStoreRefusal> {
  return db.transaction(async (tx) => {
    // Serializes one member's creates, so two requests at once cannot both pass the limit.
    await tx.query('SELECT id FROM members WHERE id = $1 FOR UPDATE', [input.ownerId]);
    const [existing] = await tx.query<Store>(`SELECT ${STORE_COLUMNS} FROM ${STORE_FROM} WHERE s.slug = $1`, [
      input.slug,
    ]);
    if (existing) {
      if (existing.ownerId !== input.ownerId) return 'slug_taken';
      return existing.status === 'deleting' ? 'being_deleted' : { store: existing, created: false };
    }
    const taken = await tx.query(
      'SELECT 1 FROM upstreams WHERE slug = $1 UNION ALL SELECT 1 FROM hosted_servers WHERE slug = $1',
      [input.slug],
    );
    if (taken.length) return 'slug_taken';
    const [{ count }] = (await tx.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM stores WHERE owner_id = $1',
      [input.ownerId],
    )) as [{ count: number }];
    if (count >= input.maxPerMember) return 'limit_reached';
    const [{ id }] = (await tx.query<{ id: string }>(
      `INSERT INTO stores (slug, name, url, owner_id, status) VALUES ($1, $2, $3, $4, 'provisioning') RETURNING id`,
      [input.slug, input.name, input.url, input.ownerId],
    )) as [{ id: string }];
    const [store] = (await tx.query<Store>(`SELECT ${STORE_COLUMNS} FROM ${STORE_FROM} WHERE s.id = $1`, [
      id,
    ])) as [Store];
    return { store, created: true };
  });
}

/** Starts a new provisioning attempt for a failed store. Returns false when the store is not failed. */
export async function retryStore(db: Queryable, id: string): Promise<boolean> {
  const rows = await db.query(
    `UPDATE stores SET status = 'provisioning', reason = NULL, attempt = attempt + 1, attempt_started_at = now(), updated_at = now()
     WHERE id = $1 AND status = 'failed' RETURNING id`,
    [id],
  );
  return rows.length > 0;
}

/**
 * Marks a store for teardown and removes its upstream in the same transaction, so its tools are gone
 * before the provisioner deletes the namespace. Returns false for an unknown store.
 */
export async function requestStoreDeletion(db: Database, id: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx.query(
      `UPDATE stores SET status = 'deleting', updated_at = now() WHERE id = $1 RETURNING id`,
      [id],
    );
    if (!rows.length) return false;
    await tx.query('DELETE FROM upstreams WHERE store_id = $1', [id]);
    return true;
  });
}

/** Stores waiting for the provisioner: those being provisioned or deleted. */
export async function listStoreTasks(db: Queryable): Promise<StoreTask[]> {
  return db.query<StoreTask>(
    `SELECT id, slug, name, url, status, attempt, attempt_started_at AS "attemptStartedAt" FROM stores
     WHERE status IN ('provisioning', 'deleting') ORDER BY created_at`,
  );
}

/**
 * Marks the current attempt ready and registers the store's woo-mcp as an upstream, in one transaction.
 * Does nothing and returns false when the store has moved on (deleted, or a newer attempt started).
 * Fails the store instead when an admin has meanwhile added an upstream with the same slug.
 */
export async function markStoreReady(db: Database, task: StoreTask): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [current] = await tx.query(
      `SELECT id FROM stores WHERE id = $1 AND status = 'provisioning' AND attempt = $2 FOR UPDATE`,
      [task.id, task.attempt],
    );
    if (!current) return false;
    const [upstream] = await tx.query(
      `INSERT INTO upstreams (slug, name, url, auth_type, store_id) VALUES ($1, $2, $3, 'none', $4)
       ON CONFLICT (slug) DO NOTHING RETURNING id`,
      [task.slug, task.name, storeMcpUrl(task.slug), task.id],
    );
    if (!upstream) {
      await tx.query(`UPDATE stores SET status = 'failed', reason = $2, updated_at = now() WHERE id = $1`, [
        task.id,
        'Another server took this store’s slug. Delete the store and create it with another name.',
      ]);
      return false;
    }
    await tx.query(`UPDATE stores SET status = 'ready', reason = NULL, updated_at = now() WHERE id = $1`, [
      task.id,
    ]);
    // Sent on commit, so every gateway replica connects to the store's woo-mcp at once.
    await announceChange(tx, 'upstreams', 'provisioner');
    return true;
  });
}

/** Fails the current attempt with a reason for the owner. Does nothing when the store has moved on. */
export async function markStoreFailed(db: Queryable, task: StoreTask, reason: string): Promise<void> {
  await db.query(
    `UPDATE stores SET status = 'failed', reason = $3, updated_at = now()
     WHERE id = $1 AND status = 'provisioning' AND attempt = $2`,
    [task.id, task.attempt, reason],
  );
}

/** Removes a store whose namespace is gone. Its upstream goes with it. */
export async function removeStore(db: Queryable, id: string): Promise<void> {
  await db.query(`DELETE FROM stores WHERE id = $1 AND status = 'deleting'`, [id]);
}
