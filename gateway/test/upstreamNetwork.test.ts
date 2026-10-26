import { describe, expect, it } from 'vitest';

import {
  addressRefusal,
  BlockedAddressError,
  createGuardedFetch,
  upstreamUrlRefusal,
} from '../src/upstreamNetwork.js';

const policy = { internalHosts: ['notes-mcp', 'woo-mcp.store-*.svc.cluster.local'] };

describe('upstream network policy', () => {
  it('refuses loopback, link-local and metadata addresses for every host', () => {
    for (const address of [
      '127.0.0.1',
      '169.254.169.254',
      '0.0.0.0',
      '::1',
      'fe80::1',
      'fd00:ec2::254',
      '::ffff:169.254.169.254',
    ]) {
      expect(addressRefusal('notes-mcp', address, policy), address).toMatch(/loopback, link-local/);
    }
  });

  it('allows private addresses only for hosts that match an internal host pattern', () => {
    expect(addressRefusal('notes-mcp', '10.43.12.7', policy)).toBeUndefined();
    expect(addressRefusal('woo-mcp.store-delhi.svc.cluster.local', '10.43.5.5', policy)).toBeUndefined();
    expect(addressRefusal('woo-mcp.store-delhi.svc.cluster.local.', '10.43.5.5', policy)).toBeUndefined();
    // A pattern's * stays within one label.
    expect(addressRefusal('woo-mcp.store-a.evil.svc.cluster.local', '10.43.5.5', policy)).toMatch(/private/);
    expect(addressRefusal('kubernetes.default.svc.cluster.local', '10.43.0.1', policy)).toMatch(/private/);
    expect(addressRefusal('evil.example.com', '192.168.1.10', policy)).toMatch(/private/);
    expect(addressRefusal('evil.example.com', 'fd12::1', policy)).toMatch(/private/);
    expect(addressRefusal('mcp.example.com', '203.0.113.7', policy)).toBeUndefined();
  });

  it('checks the addresses a saved URL resolves to', async () => {
    const resolvesTo = (addresses: string[]) => async () => addresses;
    expect(
      await upstreamUrlRefusal('http://mcp.example.com/mcp', policy, resolvesTo(['203.0.113.7'])),
    ).toBeUndefined();
    expect(
      await upstreamUrlRefusal(
        'http://rebind.example.com/mcp',
        policy,
        resolvesTo(['203.0.113.7', '10.0.0.1']),
      ),
    ).toMatch(/private/);
    expect(await upstreamUrlRefusal('http://[fe80::1]/mcp', policy)).toMatch(/link-local/);
  });

  it('refuses a connection when the host resolves to a blocked address at connect time', async () => {
    const guardedFetch = createGuardedFetch(policy);
    // localhost resolves to loopback only when the connection is made, as with DNS rebinding.
    const error = await guardedFetch('http://localhost:59999/mcp').catch((caught: unknown) => caught);
    expect((error as Error).cause).toBeInstanceOf(BlockedAddressError);
    await expect(guardedFetch('http://127.0.0.1:59999/mcp')).rejects.toBeInstanceOf(BlockedAddressError);
  });
});
