import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createCredentialCipher, CredentialDecryptError } from '../src/credentialCipher.js';
import { encryptStoredCredentials, listUpstreamConfigs } from '../src/upstreams.js';
import { createTestDatabase } from './database.js';

describe('credential encryption', () => {
  it('round-trips a secret with a fresh IV each time and refuses another key or a changed value', () => {
    const cipher = createCredentialCipher(randomBytes(32));
    const first = cipher.encrypt('notes-token');
    const second = cipher.encrypt('notes-token');

    expect(first).not.toBe(second);
    expect(cipher.decrypt(first)).toBe('notes-token');
    expect(cipher.isEncrypted(first)).toBe(true);
    expect(cipher.isEncrypted('notes-token')).toBe(false);
    expect(() => createCredentialCipher(randomBytes(32)).decrypt(first)).toThrow(CredentialDecryptError);
    const [format, iv, tag, ciphertext] = first.split(':');
    const flipped = Buffer.from(ciphertext!, 'base64');
    flipped[0]! ^= 1;
    expect(() => cipher.decrypt([format, iv, tag, flipped.toString('base64')].join(':'))).toThrow(
      CredentialDecryptError,
    );
  });

  it('encrypts credentials an older gateway stored in clear, and stops on a wrong key', async () => {
    const db = await createTestDatabase();
    const cipher = createCredentialCipher(randomBytes(32));
    await db.query(
      `INSERT INTO upstreams (slug, name, url, auth_type, auth_secret) VALUES ('notes', 'Notes', 'http://notes-mcp:3000/mcp', 'bearer', 'old-token')`,
    );

    expect(await encryptStoredCredentials(db, cipher)).toBe(1);
    expect(await encryptStoredCredentials(db, cipher)).toBe(0);
    const [row] = await db.query<{ secret: string }>('SELECT auth_secret AS secret FROM upstreams');
    expect(row!.secret).toMatch(/^v1:/);
    expect((await listUpstreamConfigs(db, cipher))[0]!.credential).toEqual({
      header: 'authorization',
      value: 'Bearer old-token',
    });
    await expect(encryptStoredCredentials(db, createCredentialCipher(randomBytes(32)))).rejects.toThrow(
      CredentialDecryptError,
    );
    await db.close();
  });
});
