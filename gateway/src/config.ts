import * as z from 'zod/v4';

import type { PostgresSettings } from './db.js';
import { MIN_PASSWORD_LENGTH } from './team.js';
import { SLUG_PATTERN } from './upstreams.js';

export interface GatewayConfig {
  port: number;
  /** Where people reach the dashboard and /mcp, such as http://app.localtest.me. Used in invite links. */
  publicUrl: URL;
  database: PostgresSettings;
  /** Becomes the first admin when the team has no members. */
  firstAdmin: { email: string; password: string };
  /** The upstream registered on first start (WooCommerce). */
  seedUpstream: { name: string; slug: string; url: string };
}

const httpUrl = z.url({ protocol: /^https?$/ });

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  PUBLIC_URL: httpUrl,
  PGHOST: z.string().min(1),
  PGPORT: z.coerce.number().int().min(1).max(65535).default(5432),
  PGUSER: z.string().min(1),
  PGPASSWORD: z.string().min(1),
  PGDATABASE: z.string().min(1),
  BOOTSTRAP_ADMIN_EMAIL: z.email(),
  BOOTSTRAP_ADMIN_PASSWORD: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `must be at least ${MIN_PASSWORD_LENGTH} characters`),
  SEED_UPSTREAM_NAME: z.string().min(1).max(100),
  SEED_UPSTREAM_SLUG: z.string().regex(SLUG_PATTERN, 'must be 2-16 characters of a-z, 0-9 and -'),
  SEED_UPSTREAM_URL: httpUrl,
});

/**
 * Reads and validates gateway settings from the environment.
 * Throws one error listing every missing or invalid variable. Messages never include the values.
 */
export function loadConfig(env: NodeJS.ProcessEnv): GatewayConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }
  const vars = parsed.data;
  return {
    port: vars.PORT,
    publicUrl: new URL(vars.PUBLIC_URL),
    database: {
      host: vars.PGHOST,
      port: vars.PGPORT,
      user: vars.PGUSER,
      password: vars.PGPASSWORD,
      database: vars.PGDATABASE,
    },
    firstAdmin: { email: vars.BOOTSTRAP_ADMIN_EMAIL, password: vars.BOOTSTRAP_ADMIN_PASSWORD },
    seedUpstream: {
      name: vars.SEED_UPSTREAM_NAME,
      slug: vars.SEED_UPSTREAM_SLUG,
      url: vars.SEED_UPSTREAM_URL,
    },
  };
}
