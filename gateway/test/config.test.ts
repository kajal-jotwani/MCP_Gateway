import { describe, expect, it } from 'vitest';

import { loadConfig, loadProvisionerConfig } from '../src/config.js';

const validEnv = {
  PUBLIC_URL: 'http://app.localtest.me',
  PGHOST: 'postgres',
  PGUSER: 'gateway',
  PGPASSWORD: 'database-password',
  PGDATABASE: 'gateway',
  BOOTSTRAP_ADMIN_EMAIL: 'admin@example.com',
  BOOTSTRAP_ADMIN_PASSWORD: 'first-admin-password',
  SEED_UPSTREAM_NAME: 'WooCommerce',
  SEED_UPSTREAM_SLUG: 'woocommerce',
  SEED_UPSTREAM_URL: 'http://woo-mcp.store.svc.cluster.local:3000/mcp',
  ANTHROPIC_API_KEY: 'test-anthropic-key',
  UPSTREAM_CREDENTIAL_KEY: Buffer.alloc(32, 7).toString('base64'),
  STORE_DOMAIN: 'localtest.me',
  MAX_STORES_PER_MEMBER: '3',
};

describe('loadConfig', () => {
  it('reads a valid environment and fills in the default ports', () => {
    const config = loadConfig(validEnv);
    expect(config.port).toBe(8080);
    expect(config.database).toMatchObject({ host: 'postgres', port: 5432, database: 'gateway' });
    expect(config.publicUrl.href).toBe('http://app.localtest.me/');
    expect(config.seedUpstream).toEqual({
      name: 'WooCommerce',
      slug: 'woocommerce',
      url: 'http://woo-mcp.store.svc.cluster.local:3000/mcp',
    });
  });

  it('reads the credential key and the internal host patterns', () => {
    const config = loadConfig({
      ...validEnv,
      UPSTREAM_INTERNAL_HOSTS: 'notes-mcp, Woo-MCP.store-*.svc.cluster.local',
    });
    expect(config.credentialKey).toEqual(Buffer.alloc(32, 7));
    expect(config.upstreamNetwork.internalHosts).toEqual(['notes-mcp', 'woo-mcp.store-*.svc.cluster.local']);
    expect(loadConfig(validEnv).upstreamNetwork.internalHosts).toEqual([]);
    expect(() =>
      loadConfig({ ...validEnv, UPSTREAM_CREDENTIAL_KEY: Buffer.alloc(16).toString('base64') }),
    ).toThrow(/UPSTREAM_CREDENTIAL_KEY/);
    expect(() => loadConfig({ ...validEnv, UPSTREAM_INTERNAL_HOSTS: 'http://x/' })).toThrow(
      /UPSTREAM_INTERNAL_HOSTS/,
    );
  });

  it('names every invalid variable without echoing secret values', () => {
    const shortPassword = 'short-pw';
    let message = '';
    try {
      loadConfig({
        ...validEnv,
        PGPASSWORD: undefined,
        ANTHROPIC_API_KEY: '',
        BOOTSTRAP_ADMIN_PASSWORD: shortPassword,
        SEED_UPSTREAM_SLUG: 'Not A Slug',
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('PGPASSWORD');
    expect(message).toContain('ANTHROPIC_API_KEY');
    expect(message).toContain('BOOTSTRAP_ADMIN_PASSWORD');
    expect(message).toContain('SEED_UPSTREAM_SLUG');
    expect(message).not.toContain(shortPassword);
  });
});

describe('loadProvisionerConfig', () => {
  const provisionerEnv = {
    PGHOST: 'postgres',
    PGUSER: 'gateway',
    PGPASSWORD: 'database-password',
    PGDATABASE: 'gateway',
    GATEWAY_NAMESPACE: 'gateway',
    PROVISIONER_SERVICE_ACCOUNT: 'gateway-provisioner',
    STORE_ROLE: 'gateway-store',
    STORE_CHART_PATH: '/app/charts/store',
    STORE_VALUES_FILE: '/config/store-values.yaml',
    PROVISION_TIMEOUT_MINUTES: '15',
  };

  it('reads a valid environment', () => {
    expect(loadProvisionerConfig(provisionerEnv)).toMatchObject({
      port: 8081,
      gatewayNamespace: 'gateway',
      valuesFiles: ['/config/store-values.yaml'],
      timeoutMs: 15 * 60_000,
    });
  });

  it('names every invalid variable', () => {
    expect(() =>
      loadProvisionerConfig({
        ...provisionerEnv,
        GATEWAY_NAMESPACE: 'Not_A_Namespace',
        PROVISION_TIMEOUT_MINUTES: '0',
      }),
    ).toThrow(/GATEWAY_NAMESPACE[\s\S]*PROVISION_TIMEOUT_MINUTES/);
  });
});
