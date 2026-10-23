import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';

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

  it('names every invalid variable without echoing secret values', () => {
    const shortPassword = 'short-pw';
    let message = '';
    try {
      loadConfig({
        ...validEnv,
        PGPASSWORD: undefined,
        BOOTSTRAP_ADMIN_PASSWORD: shortPassword,
        SEED_UPSTREAM_SLUG: 'Not A Slug',
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('PGPASSWORD');
    expect(message).toContain('BOOTSTRAP_ADMIN_PASSWORD');
    expect(message).toContain('SEED_UPSTREAM_SLUG');
    expect(message).not.toContain(shortPassword);
  });
});
