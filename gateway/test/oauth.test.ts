import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  oauthIssuerFor,
  pkceMatches,
  redirectUriRefusal,
  redirectUriRegistered,
  resourceAccepted,
} from '../src/oauth.js';

describe('OAuth redirect URIs', () => {
  it('allows https, loopback http and app schemes, and refuses the rest', () => {
    expect(redirectUriRefusal('https://app.example/callback')).toBeUndefined();
    expect(redirectUriRefusal('http://127.0.0.1:3118/callback')).toBeUndefined();
    expect(redirectUriRefusal('http://localhost/callback')).toBeUndefined();
    expect(redirectUriRefusal('cursor://anysphere.cursor-mcp/oauth/callback')).toBeUndefined();
    expect(redirectUriRefusal('http://app.example/callback')).toMatch(/loopback|localhost/);
    expect(redirectUriRefusal('javascript:alert(1)')).toMatch(/not allowed/);
    expect(redirectUriRefusal('https://app.example/cb#fragment')).toMatch(/fragment/);
    expect(redirectUriRefusal('/callback')).toMatch(/absolute/);
  });

  it('matches loopback redirect URIs on any port, and everything else exactly', () => {
    const registered = ['http://127.0.0.1:3118/callback', 'https://app.example/cb'];
    expect(redirectUriRegistered(registered, 'http://127.0.0.1:50211/callback')).toBe(true);
    expect(redirectUriRegistered(registered, 'http://127.0.0.1:50211/other')).toBe(false);
    expect(redirectUriRegistered(registered, 'http://localhost:3118/callback')).toBe(false);
    expect(redirectUriRegistered(registered, 'https://app.example/cb')).toBe(true);
    expect(redirectUriRegistered(registered, 'https://app.example:8443/cb')).toBe(false);
    expect(redirectUriRegistered(registered, 'https://app.example/cb?next=x')).toBe(false);
  });
});

describe('PKCE and resource indicators', () => {
  it('accepts only the verifier whose S256 hash is the challenge', () => {
    const verifier = 'a'.repeat(43);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    expect(pkceMatches(verifier, challenge)).toBe(true);
    expect(pkceMatches('b'.repeat(43), challenge)).toBe(false);
    // Too short to carry the 256 bits PKCE relies on.
    const short = 'a'.repeat(42);
    expect(pkceMatches(short, createHash('sha256').update(short).digest('base64url'))).toBe(false);
  });

  it('accepts the gateway’s MCP endpoint as the resource, or none', () => {
    const issuer = oauthIssuerFor(new URL('https://app.example.com'));
    expect(issuer).toEqual({ issuer: 'https://app.example.com', resource: 'https://app.example.com/mcp' });
    expect(resourceAccepted(undefined, issuer)).toBe(true);
    expect(resourceAccepted('https://app.example.com/mcp/', issuer)).toBe(true);
    expect(resourceAccepted('https://other.example.com/mcp', issuer)).toBe(false);
  });
});
