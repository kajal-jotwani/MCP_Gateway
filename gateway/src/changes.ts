import type { Database, Queryable } from './db.js';
import type { UpstreamConfig, UpstreamRegistry } from './registry.js';

const CHANGES_CHANNEL = 'gateway_changes';

/** What changed: the upstreams table, or which tools members may see. */
export type Change = 'upstreams' | 'access';

/**
 * Tells every gateway replica about a change. `origin` names the sender, so a replica can skip what it
 * already applied itself. Inside a transaction PostgreSQL sends it on commit, and not on rollback.
 */
export async function announceChange(db: Queryable, change: Change, origin: string): Promise<void> {
  await db.query('SELECT pg_notify($1, $2)', [CHANGES_CHANNEL, `${change}:${origin}`]);
}

/**
 * Applies changes that other replicas and the provisioner announce to this replica's registry:
 * re-reads the upstreams, or tells listening clients to list their tools again. The periodic reload
 * still runs, and covers anything missed while the listening connection was down.
 */
export function followChanges(
  db: Database,
  registry: UpstreamRegistry,
  loadUpstreams: () => Promise<UpstreamConfig[]>,
  origin: string,
): Promise<void> {
  return db.listen(CHANGES_CHANNEL, (payload) => {
    const separator = payload.indexOf(':');
    if (payload.slice(separator + 1) === origin) return;
    if (payload.slice(0, separator) === 'access') {
      registry.announceToolsChanged();
      return;
    }
    registry.reload(loadUpstreams).catch((error: unknown) => {
      console.error(JSON.stringify({ event: 'upstream_reload_failed', message: (error as Error).message }));
    });
  });
}
