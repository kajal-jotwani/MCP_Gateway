import { createHash, randomBytes } from 'node:crypto';

/** A new secret: 32 bytes from the operating system's CSPRNG, base64url-encoded (43 characters). */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * SHA-256 hex digest of a token. Tokens carry 256 bits of randomness, so a fast hash cannot be
 * brute-forced, and it lets the database look a token up by its hash.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
