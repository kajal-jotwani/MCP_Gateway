import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** A stored credential that does not decrypt: another key, a changed value, or not encrypted. */
export class CredentialDecryptError extends Error {}

/** Encrypts upstream credentials before they are stored and decrypts them for the upstream clients. */
export interface CredentialCipher {
  encrypt(plaintext: string): string;
  /** Throws CredentialDecryptError when the value was encrypted with another key or has been changed. */
  decrypt(stored: string): string;
  isEncrypted(stored: string): boolean;
}

// The version prefix leaves room for a second format or key without guessing at old values.
const FORMAT = 'v1';
const IV_BYTES = 12;

/**
 * AES-256-GCM with a random 96-bit IV per value, stored as `v1:<iv>:<tag>:<ciphertext>` in base64.
 * GCM's tag makes a changed or wrongly keyed value fail to decrypt instead of yielding garbage.
 */
export function createCredentialCipher(key: Buffer): CredentialCipher {
  if (key.length !== 32) throw new Error('The credential key must be 32 bytes.');
  return {
    encrypt(plaintext) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const parts = [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64'));
      return [FORMAT, ...parts].join(':');
    },
    decrypt(stored) {
      const [format, iv, tag, ciphertext] = stored.split(':');
      if (format !== FORMAT || !iv || !tag || ciphertext === undefined) {
        throw new CredentialDecryptError('The stored credential is not in the encrypted format.');
      }
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
        decipher.setAuthTag(Buffer.from(tag, 'base64'));
        const plaintext = Buffer.concat([
          decipher.update(Buffer.from(ciphertext, 'base64')),
          decipher.final(),
        ]);
        return plaintext.toString('utf8');
      } catch {
        // Node reports a failed tag check as "unable to authenticate data", which says nothing useful.
        throw new CredentialDecryptError('The stored credential does not decrypt with this key.');
      }
    },
    isEncrypted(stored) {
      return stored.startsWith(`${FORMAT}:`);
    },
  };
}
