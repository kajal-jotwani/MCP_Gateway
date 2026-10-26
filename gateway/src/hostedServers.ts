import { announceChange } from './changes.js';
import type { CredentialCipher } from './credentialCipher.js';
import type { Database, Queryable } from './db.js';

export type HostedServerStatus = 'provisioning' | 'ready' | 'failed' | 'deleting';

/** A hosted MCP server as the dashboard API shows it. Environment values are never included. */
export interface HostedServer {
  id: string;
  slug: string;
  name: string;
  image: string;
  port: number;
  path: string;
  envNames: string[];
  status: HostedServerStatus;
  /** Why the server failed, for admins to read. Never holds environment values. */
  reason: string | null;
  createdAt: Date;
}

/** A hosted server row as the provisioner works with it, with its environment still encrypted. */
export interface HostedServerTask {
  id: string;
  slug: string;
  name: string;
  image: string;
  port: number;
  path: string;
  env: string;
  status: 'provisioning' | 'deleting';
  attempt: number;
  attemptStartedAt: Date;
}

export interface HostedServerInput {
  slug: string;
  name: string;
  image: string;
  port: number;
  path: string;
  env: Record<string, string>;
}

// An image reference with a registry path, then a tag or a digest: nginx:1.27, ghcr.io/org/mcp:2.0.1,
// repo@sha256:... Pinning is required, so the server a rollback returns to is the one that ran.
const IMAGE_PATTERN =
  /^[a-z0-9]+([._-][a-z0-9]+)*(:[0-9]+)?(\/[a-z0-9]+([._-][a-z0-9]+)*)*(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|@sha256:[a-f0-9]{64})$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
// The chart sets HOME; the rest would let a server's environment change how its container starts.
const RESERVED_ENV_NAMES = new Set(['HOME', 'PATH', 'LD_PRELOAD', 'NODE_OPTIONS']);

/** Why an image reference cannot be hosted, or undefined. It must name a tag other than latest, or a digest. */
export function imageRefusal(image: string): string | undefined {
  if (!IMAGE_PATTERN.test(image)) return 'use a pinned image reference such as ghcr.io/org/server:1.2.0';
  if (image.endsWith(':latest')) return 'pin a version instead of latest';
  return undefined;
}

/** Why an environment variable name cannot be set, or undefined. */
export function envNameRefusal(name: string): string | undefined {
  if (!ENV_NAME_PATTERN.test(name)) return `${name.slice(0, 64)} is not a valid variable name`;
  if (RESERVED_ENV_NAMES.has(name)) return `${name} is set by the platform`;
  return undefined;
}

/** The namespace a hosted server is installed in. */
export function hostedServerNamespace(slug: string): string {
  return `mcp-${slug}`;
}

/** The in-cluster address the gateway registers as the server's upstream. */
export function hostedServerUrl(task: Pick<HostedServerTask, 'slug' | 'port' | 'path'>): string {
  return `http://server.${hostedServerNamespace(task.slug)}.svc.cluster.local:${task.port}${task.path}`;
}

const VIEW_COLUMNS = `id, slug, name, image, port, path, env, status, reason, created_at AS "createdAt"`;

function toView(
  row: Omit<HostedServer, 'envNames'> & { env: string },
  cipher: CredentialCipher,
): HostedServer {
  const { env, ...server } = row;
  return { ...server, envNames: Object.keys(JSON.parse(cipher.decrypt(env)) as Record<string, string>) };
}

export async function listHostedServers(db: Queryable, cipher: CredentialCipher): Promise<HostedServer[]> {
  const rows = await db.query<Omit<HostedServer, 'envNames'> & { env: string }>(
    `SELECT ${VIEW_COLUMNS} FROM hosted_servers ORDER BY created_at`,
  );
  return rows.map((row) => toView(row, cipher));
}

export async function getHostedServer(
  db: Queryable,
  cipher: CredentialCipher,
  id: string,
): Promise<HostedServer | undefined> {
  const [row] = await db.query<Omit<HostedServer, 'envNames'> & { env: string }>(
    `SELECT ${VIEW_COLUMNS} FROM hosted_servers WHERE id = $1`,
    [id],
  );
  return row && toView(row, cipher);
}

/**
 * Records a hosted server for the provisioner to deploy, with its environment encrypted. Returns
 * 'slug_taken' when an upstream, a store or another hosted server has the slug.
 */
export async function createHostedServer(
  db: Queryable,
  cipher: CredentialCipher,
  input: HostedServerInput & { createdBy: string },
): Promise<HostedServer | 'slug_taken'> {
  const [row] = await db.query<{ id: string }>(
    `INSERT INTO hosted_servers (slug, name, image, port, path, env, status, created_by)
     SELECT $1, $2, $3, $4, $5, $6, 'provisioning', $7
     WHERE NOT EXISTS (SELECT 1 FROM upstreams WHERE slug = $1)
       AND NOT EXISTS (SELECT 1 FROM stores WHERE slug = $1)
     ON CONFLICT (slug) DO NOTHING RETURNING id`,
    [
      input.slug,
      input.name,
      input.image,
      input.port,
      input.path,
      cipher.encrypt(JSON.stringify(input.env)),
      input.createdBy,
    ],
  );
  return row ? (await getHostedServer(db, cipher, row.id))! : 'slug_taken';
}

/** Starts a new attempt for a failed server. Returns false when the server is not failed. */
export async function retryHostedServer(db: Queryable, id: string): Promise<boolean> {
  const rows = await db.query(
    `UPDATE hosted_servers SET status = 'provisioning', reason = NULL, attempt = attempt + 1,
       attempt_started_at = now(), updated_at = now()
     WHERE id = $1 AND status = 'failed' RETURNING id`,
    [id],
  );
  return rows.length > 0;
}

/**
 * Marks a server for teardown and removes its upstream in the same transaction, so its tools are gone
 * before the provisioner deletes the namespace. Returns false for an unknown server.
 */
export async function requestHostedServerDeletion(db: Database, id: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx.query(
      `UPDATE hosted_servers SET status = 'deleting', updated_at = now() WHERE id = $1 RETURNING id`,
      [id],
    );
    if (!rows.length) return false;
    await tx.query('DELETE FROM upstreams WHERE hosted_server_id = $1', [id]);
    return true;
  });
}

/** Hosted servers waiting for the provisioner: those being deployed or deleted. */
export async function listHostedServerTasks(db: Queryable): Promise<HostedServerTask[]> {
  return db.query<HostedServerTask>(
    `SELECT id, slug, name, image, port, path, env, status, attempt, attempt_started_at AS "attemptStartedAt"
     FROM hosted_servers WHERE status IN ('provisioning', 'deleting') ORDER BY created_at`,
  );
}

/**
 * Marks the current attempt ready and registers the server as an upstream, in one transaction, and
 * announces it to every gateway replica on commit. Returns false when the attempt is no longer
 * current, or fails the server when another upstream took its slug meanwhile.
 */
export async function markHostedServerReady(db: Database, task: HostedServerTask): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [current] = await tx.query(
      `SELECT id FROM hosted_servers WHERE id = $1 AND status = 'provisioning' AND attempt = $2 FOR UPDATE`,
      [task.id, task.attempt],
    );
    if (!current) return false;
    const [upstream] = await tx.query(
      `INSERT INTO upstreams (slug, name, url, auth_type, hosted_server_id) VALUES ($1, $2, $3, 'none', $4)
       ON CONFLICT (slug) DO NOTHING RETURNING id`,
      [task.slug, task.name, hostedServerUrl(task), task.id],
    );
    if (!upstream) {
      await tx.query(
        `UPDATE hosted_servers SET status = 'failed', reason = $2, updated_at = now() WHERE id = $1`,
        [task.id, 'Another server took this slug. Delete this one and add it again with another slug.'],
      );
      return false;
    }
    await tx.query(
      `UPDATE hosted_servers SET status = 'ready', reason = NULL, updated_at = now() WHERE id = $1`,
      [task.id],
    );
    await announceChange(tx, 'upstreams', 'provisioner');
    return true;
  });
}

/** Fails the current attempt with a reason for admins. Does nothing when the server has moved on. */
export async function markHostedServerFailed(
  db: Queryable,
  task: HostedServerTask,
  reason: string,
): Promise<void> {
  await db.query(
    `UPDATE hosted_servers SET status = 'failed', reason = $3, updated_at = now()
     WHERE id = $1 AND status = 'provisioning' AND attempt = $2`,
    [task.id, task.attempt, reason],
  );
}

/** Removes a hosted server whose namespace is gone. */
export async function removeHostedServer(db: Queryable, id: string): Promise<void> {
  await db.query(`DELETE FROM hosted_servers WHERE id = $1 AND status = 'deleting'`, [id]);
}
