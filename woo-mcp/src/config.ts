import * as z from 'zod/v4';

export interface WooMcpConfig {
  port: number;
  /** Where REST requests are sent: the WordPress Service inside the cluster. */
  apiUrl: URL;
  /** The WordPress home URL. WooCommerce rebuilds the OAuth signature from it, not from the Host header. */
  siteUrl: URL;
  consumerKey: string;
  consumerSecret: string;
  storeTimezone: string;
}

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  WOO_API_URL: z.url({ protocol: /^https?$/ }),
  WOO_SITE_URL: z.url({ protocol: /^https?$/ }),
  WC_CONSUMER_KEY: z.string().regex(/^ck_[0-9a-f]{40}$/, 'must be ck_ followed by 40 hex characters'),
  WC_CONSUMER_SECRET: z.string().regex(/^cs_[0-9a-f]{40}$/, 'must be cs_ followed by 40 hex characters'),
  STORE_TIMEZONE: z.string().refine(isTimeZone, 'must be an IANA time zone such as Asia/Kolkata'),
});

/**
 * Reads and validates woo-mcp settings from the environment.
 * Throws one error listing every missing or invalid variable. Messages never include the values.
 */
export function loadConfig(env: NodeJS.ProcessEnv): WooMcpConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }
  const vars = parsed.data;
  return {
    port: vars.PORT,
    apiUrl: new URL(vars.WOO_API_URL),
    siteUrl: new URL(vars.WOO_SITE_URL),
    consumerKey: vars.WC_CONSUMER_KEY,
    consumerSecret: vars.WC_CONSUMER_SECRET,
    storeTimezone: vars.STORE_TIMEZONE,
  };
}
