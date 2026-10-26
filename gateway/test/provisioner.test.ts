import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { randomBytes } from 'node:crypto';

import { HelmError } from '../src/cluster.js';
import type { HelmChart, NamespaceState, StoreCluster } from '../src/cluster.js';
import { createCredentialCipher } from '../src/credentialCipher.js';
import type { Database } from '../src/db.js';
import {
  createHostedServer,
  envNameRefusal,
  getHostedServer,
  imageRefusal,
  requestHostedServerDeletion,
} from '../src/hostedServers.js';
import { hostedServerKind, Provisioner, storeKind } from '../src/provisioner.js';
import { createStore, getStore, requestStoreDeletion } from '../src/stores.js';
import type { Store } from '../src/stores.js';
import { createMember } from '../src/team.js';
import { createTestDatabase } from './database.js';

const SETTINGS = { timeoutMs: 15 * 60_000 };
const STORE_CHART = { release: 'store', path: '/app/charts/store', valuesFiles: [] };
const SERVER_CHART = { release: 'server', path: '/app/charts/hosted-mcp', valuesFiles: [] };
const cipher = createCredentialCipher(randomBytes(32));

interface Install {
  namespace: string;
  chart: HelmChart;
  values: Record<string, unknown>;
  timeoutMs: number;
  signal: AbortSignal;
  finish: (error?: Error) => void;
}

/** An in-memory cluster. Installs stay open until the test finishes them, as a slow Helm would. */
class FakeCluster implements StoreCluster {
  namespaces = new Map<string, NamespaceState & { labelled: boolean; granted?: boolean }>();
  /** Each namespace's one Secret, with its name. */
  secrets = new Map<string, { name: string; data: Record<string, string> }>();
  releases = new Map<string, string>();
  installs: Install[] = [];
  uninstalls: string[] = [];
  failNextGet?: Error;

  async getNamespace(name: string) {
    if (this.failNextGet) {
      const error = this.failNextGet;
      this.failNextGet = undefined;
      throw error;
    }
    const namespace = this.namespaces.get(name);
    return namespace && { ownerId: namespace.ownerId, terminating: namespace.terminating };
  }
  async createNamespace(name: string, ownerId: string) {
    this.namespaces.set(name, { ownerId, terminating: false, labelled: true });
  }
  async grantStoreRole(namespace: string) {
    this.namespaces.get(namespace)!.granted = true;
  }
  async deleteNamespace(name: string) {
    const namespace = this.namespaces.get(name);
    if (namespace) namespace.terminating = true;
  }
  /** What Kubernetes does once everything in a terminating namespace is gone. */
  finishTermination(name: string) {
    this.namespaces.delete(name);
    this.secrets.delete(name);
    this.releases.delete(name);
  }
  async createSecretIfAbsent(namespace: string, name: string, data: Record<string, string>) {
    if (!this.secrets.has(namespace)) this.secrets.set(namespace, { name, data });
  }
  async releaseStatus(namespace: string) {
    return this.releases.get(namespace);
  }
  async uninstallRelease(namespace: string) {
    this.uninstalls.push(namespace);
    this.releases.delete(namespace);
  }
  installRelease(
    namespace: string,
    chart: HelmChart,
    values: Record<string, unknown>,
    timeoutMs: number,
    signal: AbortSignal,
  ) {
    this.releases.set(namespace, 'pending-install');
    return new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        this.releases.set(namespace, error ? 'failed' : 'deployed');
        if (error) reject(error);
        else resolve();
      };
      signal.addEventListener('abort', () => reject(signal.reason as Error));
      this.installs.push({ namespace, chart, values, timeoutMs, signal, finish });
    });
  }
}

let db: Database;
let cluster: FakeCluster;
let ownerId: string;
let provisioners: Provisioner[];

function newProvisioner(settings = SETTINGS): Provisioner {
  const provisioner = new Provisioner(db, cluster, settings, [
    storeKind(STORE_CHART, 'gateway'),
    hostedServerKind(SERVER_CHART, 'gateway', cipher),
  ]);
  provisioners.push(provisioner);
  return provisioner;
}

async function newStore(name: string): Promise<Store> {
  const slug = name.toLowerCase();
  const outcome = await createStore(db, {
    slug,
    name,
    url: `http://store-${slug}.localtest.me`,
    ownerId,
    maxPerMember: 10,
  });
  if (typeof outcome === 'string') throw new Error(outcome);
  return outcome.store;
}

/** Runs passes until `done` holds, the way the provisioner's loop does every few seconds. */
async function passUntil(provisioner: Provisioner, done: () => Promise<boolean> | boolean): Promise<void> {
  for (let pass = 0; pass < 20; pass++) {
    await provisioner.tick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (await done()) return;
  }
  throw new Error('condition not reached');
}

async function statusOf(store: Store): Promise<string | undefined> {
  return (await getStore(db, store.id))?.status;
}

beforeEach(async () => {
  db = await createTestDatabase();
  cluster = new FakeCluster();
  provisioners = [];
  const owner = await createMember(db, {
    email: 'owner@example.com',
    name: 'Owner',
    role: 'member',
    password: 'owner-password-123',
  });
  ownerId = owner!.id;
});

afterEach(async () => {
  await Promise.all(provisioners.map((provisioner) => provisioner.stop()));
  await db.close();
});

describe('provisioner', () => {
  it('provisions several stores at once, each in its own labelled namespace with its own Secret', async () => {
    const delhi = await newStore('Delhi');
    const pune = await newStore('Pune');
    const provisioner = newProvisioner();

    await passUntil(provisioner, () => cluster.installs.length === 2);
    expect(cluster.namespaces.get('store-delhi')).toMatchObject({
      ownerId: delhi.id,
      labelled: true,
      granted: true,
    });
    expect(cluster.namespaces.get('store-pune')).toMatchObject({ ownerId: pune.id });
    const { name: secretName, data: secret } = cluster.secrets.get('store-delhi')!;
    expect(secretName).toBe('store-credentials');
    expect(Object.keys(secret).sort()).toEqual(
      [
        'MARIADB_PASSWORD',
        'MARIADB_ROOT_PASSWORD',
        'WC_CONSUMER_KEY',
        'WC_CONSUMER_SECRET',
        'WORDPRESS_ADMIN_PASSWORD',
        ...['AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY'].map((key) => `WORDPRESS_${key}`),
        ...['AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT'].map((key) => `WORDPRESS_${key}`),
      ].sort(),
    );
    expect(secret.WC_CONSUMER_KEY).toMatch(/^ck_[0-9a-f]{40}$/);
    expect(cluster.secrets.get('store-pune')!.data.MARIADB_PASSWORD).not.toBe(secret.MARIADB_PASSWORD);
    expect(cluster.installs[0]).toMatchObject({
      namespace: 'store-delhi',
      chart: STORE_CHART,
      values: {
        store: { url: 'http://store-delhi.localtest.me', title: 'Delhi' },
        gatewayNamespace: 'gateway',
      },
    });
    expect(cluster.installs[0]!.timeoutMs).toBeGreaterThan(14 * 60_000);
    expect(await statusOf(delhi)).toBe('provisioning');

    for (const install of cluster.installs) install.finish();
    await provisioner.idle();
    expect(await statusOf(delhi)).toBe('ready');
    expect(await statusOf(pune)).toBe('ready');
    expect(
      await db.query(
        'SELECT slug, url, store_id AS "storeId" FROM upstreams WHERE store_id IS NOT NULL ORDER BY slug',
      ),
    ).toEqual([
      { slug: 'delhi', url: 'http://woo-mcp.store-delhi.svc.cluster.local:3000/mcp', storeId: delhi.id },
      { slug: 'pune', url: 'http://woo-mcp.store-pune.svc.cluster.local:3000/mcp', storeId: pune.id },
    ]);
  });

  it('resumes after a restart: reinstalls a release left pending and keeps the store’s Secret', async () => {
    const store = await newStore('Delhi');
    const first = newProvisioner();
    await passUntil(first, () => cluster.installs.length === 1);
    const secret = cluster.secrets.get('store-delhi');
    await first.stop();
    expect(cluster.releases.get('store-delhi')).toBe('pending-install');

    const second = newProvisioner();
    await passUntil(second, () => cluster.installs.length === 2);
    expect(cluster.uninstalls).toEqual(['store-delhi']);
    expect(cluster.secrets.get('store-delhi')).toBe(secret);
    cluster.installs[1]!.finish();
    await second.idle();
    expect(await statusOf(store)).toBe('ready');
  });

  it('only registers a store whose release finished before a restart', async () => {
    const store = await newStore('Delhi');
    cluster.namespaces.set('store-delhi', { ownerId: store.id, terminating: false, labelled: true });
    cluster.releases.set('store-delhi', 'deployed');

    await passUntil(newProvisioner(), async () => (await statusOf(store)) === 'ready');
    expect(cluster.installs).toEqual([]);
  });

  it('fails a store with the chart’s error, and with a clear reason once the timeout has passed', async () => {
    const broken = await newStore('Broken');
    const provisioner = newProvisioner();
    await passUntil(provisioner, () => cluster.installs.length === 1);
    cluster.installs[0]!.finish(new HelmError('post-install hooks failed: job store-setup failed'));
    await provisioner.idle();
    expect(await getStore(db, broken.id)).toMatchObject({
      status: 'failed',
      reason: 'The store chart failed to install: post-install hooks failed: job store-setup failed',
    });

    const late = await newStore('Late');
    await db.query(`UPDATE stores SET attempt_started_at = now() - interval '16 minutes' WHERE id = $1`, [
      late.id,
    ]);
    await passUntil(provisioner, async () => (await statusOf(late)) === 'failed');
    expect((await getStore(db, late.id))?.reason).toBe('Provisioning did not finish within 15 minutes.');
    expect(cluster.namespaces.has('store-late')).toBe(false);
  });

  it('leaves a namespace it did not create alone, when provisioning and when deleting', async () => {
    const store = await newStore('Taken');
    cluster.namespaces.set('store-taken', { ownerId: undefined, terminating: false, labelled: false });
    const provisioner = newProvisioner();
    await passUntil(provisioner, async () => (await statusOf(store)) === 'failed');
    expect((await getStore(db, store.id))?.reason).toBe(
      'The namespace store-taken already exists and does not belong to this store.',
    );

    await requestStoreDeletion(db, store.id);
    await passUntil(provisioner, async () => (await getStore(db, store.id)) === undefined);
    expect(cluster.namespaces.get('store-taken')).toMatchObject({ terminating: false });
  });

  it('cancels an install when its store is deleted, then removes the namespace and the store', async () => {
    const store = await newStore('Delhi');
    const provisioner = newProvisioner();
    await passUntil(provisioner, () => cluster.installs.length === 1);

    await requestStoreDeletion(db, store.id);
    await passUntil(provisioner, () => cluster.namespaces.get('store-delhi')?.terminating === true);
    expect(cluster.installs[0]!.signal.aborted).toBe(true);
    expect(await statusOf(store)).toBe('deleting');

    cluster.finishTermination('store-delhi');
    await passUntil(provisioner, async () => (await getStore(db, store.id)) === undefined);
    expect(cluster.secrets.has('store-delhi')).toBe(false);
  });

  it('retries a step that failed on a Kubernetes API error on the next pass', async () => {
    const store = await newStore('Delhi');
    cluster.failNextGet = new Error('Kubernetes API GET /api/v1/namespaces/store-delhi answered 503: ');
    const provisioner = newProvisioner();
    await provisioner.tick();
    await provisioner.idle();
    expect(await statusOf(store)).toBe('provisioning');
    expect(cluster.installs).toEqual([]);

    await passUntil(provisioner, () => cluster.installs.length === 1);
    cluster.installs[0]!.finish();
    await provisioner.idle();
    expect(await statusOf(store)).toBe('ready');
  });

  it('deploys a hosted server with its environment as a Secret, registers it, and tears it down', async () => {
    const admin = await createMember(db, {
      email: 'admin@example.com',
      name: 'Admin',
      role: 'admin',
      password: 'admin-password-123',
    });
    const placeholder = `value-${randomBytes(4).toString('hex')}`;
    const server = await createHostedServer(db, cipher, {
      slug: 'echo',
      name: 'Echo',
      image: 'ghcr.io/example/echo-mcp:1.2.0',
      port: 8080,
      path: '/mcp',
      env: { ECHO_SETTING: placeholder },
      createdBy: admin!.id,
    });
    if (typeof server === 'string') throw new Error(server);
    const provisioner = newProvisioner();

    await passUntil(provisioner, () => cluster.installs.length === 1);
    expect(cluster.namespaces.get('mcp-echo')).toMatchObject({ ownerId: server.id, granted: true });
    expect(cluster.secrets.get('mcp-echo')).toEqual({
      name: 'server-env',
      data: { ECHO_SETTING: placeholder },
    });
    expect(cluster.installs[0]).toMatchObject({
      namespace: 'mcp-echo',
      chart: SERVER_CHART,
      values: { image: 'ghcr.io/example/echo-mcp:1.2.0', port: 8080, gatewayNamespace: 'gateway' },
    });
    cluster.installs[0]!.finish();
    await provisioner.idle();
    expect(await getHostedServer(db, cipher, server.id)).toMatchObject({
      status: 'ready',
      envNames: ['ECHO_SETTING'],
    });
    expect(
      await db.query('SELECT slug, url FROM upstreams WHERE hosted_server_id = $1', [server.id]),
    ).toEqual([{ slug: 'echo', url: 'http://server.mcp-echo.svc.cluster.local:8080/mcp' }]);

    await requestHostedServerDeletion(db, server.id);
    expect(await db.query('SELECT 1 FROM upstreams WHERE hosted_server_id = $1', [server.id])).toEqual([]);
    await passUntil(provisioner, () => cluster.namespaces.get('mcp-echo')?.terminating === true);
    cluster.finishTermination('mcp-echo');
    await passUntil(provisioner, async () => (await getHostedServer(db, cipher, server.id)) === undefined);
  });
});

describe('hosted server settings', () => {
  it('accepts images pinned to a tag or digest, from any registry', () => {
    for (const image of [
      'nginx:1.27',
      'urumi/everything:2.0.0',
      'ghcr.io/org/team/mcp-server:v1.2.0-rc.1',
      'registry.local:5000/mcp:1',
      `ghcr.io/org/mcp@sha256:${'a'.repeat(64)}`,
    ]) {
      expect(imageRefusal(image)).toBeUndefined();
    }
  });

  it('refuses images without a pinned version, latest and malformed references', () => {
    expect(imageRefusal('urumi/everything')).toMatch(/pinned/);
    expect(imageRefusal('urumi/everything:latest')).toBe('pin a version instead of latest');
    expect(imageRefusal('Urumi/Everything:1.0')).toMatch(/pinned/);
    expect(imageRefusal('urumi/everything:1.0 --privileged')).toMatch(/pinned/);
    expect(imageRefusal('mcp@sha256:abc')).toMatch(/pinned/);
  });

  it('refuses invalid environment names and the ones the platform sets', () => {
    expect(envNameRefusal('API_BASE_URL')).toBeUndefined();
    expect(envNameRefusal('1ST')).toBe('1ST is not a valid variable name');
    expect(envNameRefusal('A-B')).toBe('A-B is not a valid variable name');
    for (const name of ['HOME', 'PATH', 'LD_PRELOAD', 'NODE_OPTIONS']) {
      expect(envNameRefusal(name)).toBe(`${name} is set by the platform`);
    }
  });
});
