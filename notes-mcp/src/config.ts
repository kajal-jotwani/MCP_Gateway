import * as z from 'zod/v4';

export interface NotesConfig {
  port: number;
  /** Clients must send this as a bearer token. */
  token: string;
}

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  NOTES_TOKEN: z.string().min(32, 'must be at least 32 characters'),
});

/**
 * Reads and validates notes-mcp settings from the environment.
 * Throws one error listing every missing or invalid variable. Messages never include the values.
 */
export function loadConfig(env: NodeJS.ProcessEnv): NotesConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }
  return { port: parsed.data.PORT, token: parsed.data.NOTES_TOKEN };
}
