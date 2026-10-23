import { describe, expect, it } from 'vitest';

import { encodeRfc3986, signQuery } from '../src/oauth1.js';

describe('encodeRfc3986', () => {
  it('encodes the characters encodeURIComponent leaves alone, like PHP rawurlencode', () => {
    expect(encodeRfc3986("it's (x)*!~")).toBe('it%27s%20%28x%29%2A%21~');
  });
});

describe('signQuery', () => {
  // Expected signature computed with WooCommerce 11.2.1's own verification steps
  // (WC_REST_Authentication::check_oauth_signature) in PHP for the same inputs.
  it('produces the signature WooCommerce computes for the same request', () => {
    const signed = signQuery(
      'get',
      'http://store.localtest.me/wp-json/wc/v3/orders',
      { search: "it's a test (x)*!~ & more", after: '2026-10-23T00:00:00', per_page: '20' },
      {
        consumerKey: 'ck_0123456789abcdef0123456789abcdef01234567',
        consumerSecret: 'cs_fedcba9876543210fedcba9876543210fedcba98',
      },
      1793000000,
      '00112233445566778899aabbccddeeff',
    );
    expect(signed).toEqual({
      search: "it's a test (x)*!~ & more",
      after: '2026-10-23T00:00:00',
      per_page: '20',
      oauth_consumer_key: 'ck_0123456789abcdef0123456789abcdef01234567',
      oauth_nonce: '00112233445566778899aabbccddeeff',
      oauth_signature_method: 'HMAC-SHA256',
      oauth_timestamp: '1793000000',
      oauth_signature: 'hxQuv0gOYaiOqTGnFV1rFTIoZvINZ6mD6+5F07Puuq4=',
    });
  });
});
