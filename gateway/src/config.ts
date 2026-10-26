import * as z from 'zod/v4';

import type { PostgresSettings } from './db.js';
import { MIN_PASSWORD_LENGTH } from './team.js';
import type { UpstreamNetworkPolicy } from './upstreamNetwork.js';
import { SLUG_PATTERN } from './upstreams.js';

export interface GatewayConfig {
  port: number;
  /** Serves Prometheus metrics, apart from the port the Ingress routes to. */
  metricsPort: number;
  /** Where people reach the dashboard and /mcp, such as http://app.localtest.me. Used in invite links. */
  publicUrl: URL;
  database: PostgresSettings;
  /** Becomes the first admin when the team has no members. */
  firstAdmin: { email: string; password: string };
  /** The upstream registered on first start (WooCommerce). */
  seedUpstream: { name: string; slug: string; url: string };
  /** The chat agent's key for the Claude API. */
  anthropicApiKey: string;
  upstreamNetwork: UpstreamNetworkPolicy;
  /** The AES-256 key upstream credentials are encrypted with in the database. */
  credentialKey: Buffer;
  stores: {
    /** Provisioned stores are served at store-<slug>.<domain>, with the scheme of publicUrl. */
    domain: string;
    maxPerMember: number;
  };
  /** Tool calls each member may make per minute; 0 turns the limit off. */
  toolCallsPerMinute: number;
}

export interface ProvisionerConfig {
  port: number;
  database: PostgresSettings;
  /** The namespace the gateway and the provisioner run in, which store charts let reach woo-mcp. */
  gatewayNamespace: string;
  /** The provisioner's service account, which it grants `storeRole` in each store namespace. */
  serviceAccount: string;
  /** The ClusterRole holding what helm needs inside a store namespace. */
  storeRole: string;
  chartPath: string;
  /** Values files applied to every store, before its own values. */
  valuesFiles: string[];
  timeoutMs: number;
}

const httpUrl = z.url({ protocol: /^https?$/ });
// A DNS name of labels, such as localtest.me or 203.0.113.7.sslip.io.
const domainName = z
  .string()
  .regex(
    /^(?=.{1,200}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
    'must be a DNS name',
  );

// A host name in which `*` may stand for part of a label, such as woo-mcp.store-*.svc.cluster.local.
const hostPatternList = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean),
  )
  .pipe(
    z.array(
      z
        .string()
        .regex(
          /^[a-z0-9*]([a-z0-9*-]*[a-z0-9*])?(\.[a-z0-9*]([a-z0-9*-]*[a-z0-9*])?)*$/,
          'must be host names, * allowed',
        ),
    ),
  );

// 32 random bytes in base64, as `openssl rand -base64 32` prints them.
const aesKey = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9+/]{43}=$/, 'must be 32 bytes in base64, such as the output of openssl rand -base64 32')
  .transform((value) => Buffer.from(value, 'base64'));

const databaseEnv = {
  PGHOST: z.string().min(1),
  PGPORT: z.coerce.number().int().min(1).max(65535).default(5432),
  PGUSER: z.string().min(1),
  PGPASSWORD: z.string().min(1),
  PGDATABASE: z.string().min(1),
};

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  METRICS_PORT: z.coerce.number().int().min(1).max(65535).default(9464),
  PUBLIC_URL: httpUrl,
  ...databaseEnv,
  BOOTSTRAP_ADMIN_EMAIL: z.email(),
  BOOTSTRAP_ADMIN_PASSWORD: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `must be at least ${MIN_PASSWORD_LENGTH} characters`),
  SEED_UPSTREAM_NAME: z.string().min(1).max(100),
  SEED_UPSTREAM_SLUG: z.string().regex(SLUG_PATTERN, 'must be 2-16 characters of a-z, 0-9 and -'),
  SEED_UPSTREAM_URL: httpUrl,
  ANTHROPIC_API_KEY: z.string().min(1),
  UPSTREAM_INTERNAL_HOSTS: hostPatternList.default([]),
  UPSTREAM_CREDENTIAL_KEY: aesKey,
  STORE_DOMAIN: domainName,
  MAX_STORES_PER_MEMBER: z.coerce.number().int().min(0).max(100),
  TOOL_CALLS_PER_MINUTE: z.coerce.number().int().min(0).max(100_000),
});

const provisionerEnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8081),
  ...databaseEnv,
  GATEWAY_NAMESPACE: z.string().regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/, 'must be a namespace name'),
  PROVISIONER_SERVICE_ACCOUNT: z.string().min(1),
  STORE_ROLE: z.string().min(1),
  STORE_CHART_PATH: z.string().min(1),
  STORE_VALUES_FILE: z.string().min(1).optional(),
  PROVISION_TIMEOUT_MINUTES: z.coerce.number().int().min(1).max(120),
});

function databaseSettings(vars: z.infer<z.ZodObject<typeof databaseEnv>>): PostgresSettings {
  return {
    host: vars.PGHOST,
    port: vars.PGPORT,
    user: vars.PGUSER,
    password: vars.PGPASSWORD,
    database: vars.PGDATABASE,
  };
}

/** Parses the environment against a schema. Throws one error listing every problem, never the values. */
function parseEnv<T>(schema: z.ZodType<T>, env: NodeJS.ProcessEnv): T {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/**
 * Reads and validates gateway settings from the environment.
 * Throws one error listing every missing or invalid variable. Messages never include the values.
 */
export function loadConfig(env: NodeJS.ProcessEnv): GatewayConfig {
  const vars = parseEnv(envSchema, env);
  return {
    port: vars.PORT,
    metricsPort: vars.METRICS_PORT,
    publicUrl: new URL(vars.PUBLIC_URL),
    database: databaseSettings(vars),
    firstAdmin: { email: vars.BOOTSTRAP_ADMIN_EMAIL, password: vars.BOOTSTRAP_ADMIN_PASSWORD },
    seedUpstream: {
      name: vars.SEED_UPSTREAM_NAME,
      slug: vars.SEED_UPSTREAM_SLUG,
      url: vars.SEED_UPSTREAM_URL,
    },
    anthropicApiKey: vars.ANTHROPIC_API_KEY,
    upstreamNetwork: { internalHosts: vars.UPSTREAM_INTERNAL_HOSTS },
    credentialKey: vars.UPSTREAM_CREDENTIAL_KEY,
    stores: { domain: vars.STORE_DOMAIN, maxPerMember: vars.MAX_STORES_PER_MEMBER },
    toolCallsPerMinute: vars.TOOL_CALLS_PER_MINUTE,
  };
}

/** Reads and validates the provisioner's settings from the environment. Throws like loadConfig. */
export function loadProvisionerConfig(env: NodeJS.ProcessEnv): ProvisionerConfig {
  const vars = parseEnv(provisionerEnvSchema, env);
  return {
    port: vars.PORT,
    database: databaseSettings(vars),
    gatewayNamespace: vars.GATEWAY_NAMESPACE,
    serviceAccount: vars.PROVISIONER_SERVICE_ACCOUNT,
    storeRole: vars.STORE_ROLE,
    chartPath: vars.STORE_CHART_PATH,
    valuesFiles: vars.STORE_VALUES_FILE ? [vars.STORE_VALUES_FILE] : [],
    timeoutMs: vars.PROVISION_TIMEOUT_MINUTES * 60_000,
  };
}
