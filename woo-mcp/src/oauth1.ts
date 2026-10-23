import { createHmac } from 'node:crypto';

export interface ConsumerCredentials {
  consumerKey: string;
  consumerSecret: string;
}

/** Percent-encodes like PHP's rawurlencode, which WooCommerce uses when it rebuilds the signature. */
export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Returns `query` plus the OAuth 1.0a parameters for a one-legged HMAC-SHA256 signed WooCommerce REST request.
 * `signatureUrl` is the URL WooCommerce rebuilds from its home URL and the request path, without a query string.
 * Only query parameters are signed; WooCommerce does not include a JSON body in the signature.
 */
export function signQuery(
  method: string,
  signatureUrl: string,
  query: Record<string, string>,
  credentials: ConsumerCredentials,
  timestamp: number,
  nonce: string,
): Record<string, string> {
  const params: Record<string, string> = {
    ...query,
    oauth_consumer_key: credentials.consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp: String(timestamp),
  };
  // WooCommerce sorts the raw keys with strcmp. The keys here are ASCII, so the default sort gives the
  // same byte order. Each key and value is encoded, then each "key=value" pair is encoded again.
  const pairs = Object.keys(params)
    .sort()
    .map((key) => encodeRfc3986(`${encodeRfc3986(key)}=${encodeRfc3986(params[key] ?? '')}`));
  const baseString = `${method.toUpperCase()}&${encodeRfc3986(signatureUrl)}&${pairs.join('%26')}`;
  const signature = createHmac('sha256', `${credentials.consumerSecret}&`)
    .update(baseString)
    .digest('base64');
  return { ...params, oauth_signature: signature };
}
