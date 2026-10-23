import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';

// Placeholder credentials, built at runtime so secret scanners do not mistake them for real keys.
const consumerKey = `ck_${'1'.repeat(40)}`;
const consumerSecret = `cs_${'2'.repeat(40)}`;

const validEnv = {
  WOO_API_URL: 'http://10.43.0.15',
  WOO_SITE_URL: 'http://store.localtest.me',
  WC_CONSUMER_KEY: consumerKey,
  WC_CONSUMER_SECRET: consumerSecret,
  STORE_TIMEZONE: 'Asia/Kolkata',
};

describe('loadConfig', () => {
  it('reads a valid environment and defaults the port', () => {
    const config = loadConfig(validEnv);
    expect(config.port).toBe(3000);
    expect(config.apiUrl.href).toBe('http://10.43.0.15/');
    expect(config.storeTimezone).toBe('Asia/Kolkata');
  });

  it('rejects a store URL that is not http or https', () => {
    expect(() => loadConfig({ ...validEnv, WOO_SITE_URL: 'ftp://store.localtest.me' })).toThrow(
      'WOO_SITE_URL',
    );
  });

  it('names every invalid variable without echoing secret values', () => {
    const badSecret = 'cs_not-a-valid-secret';
    let message = '';
    try {
      loadConfig({
        ...validEnv,
        WOO_API_URL: undefined,
        WC_CONSUMER_SECRET: badSecret,
        STORE_TIMEZONE: 'Mars/Base',
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('WOO_API_URL');
    expect(message).toContain('WC_CONSUMER_SECRET');
    expect(message).toContain('STORE_TIMEZONE');
    expect(message).not.toContain(badSecret);
  });
});
