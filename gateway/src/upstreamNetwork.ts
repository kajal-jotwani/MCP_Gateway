import { lookup as dnsLookup } from 'node:dns';
import type { LookupAddress, LookupOptions } from 'node:dns';
import { BlockList, isIP } from 'node:net';

import { Agent, fetch as undiciFetch } from 'undici';

/** Where upstream URLs may point. Read from the environment once at startup. */
export interface UpstreamNetworkPolicy {
  /**
   * Host name patterns that may resolve to private and cluster-internal addresses, such as
   * `woo-mcp.store-*.svc.cluster.local`. A `*` matches within one DNS label.
   */
  internalHosts: string[];
}

/** A connection the network policy refused. The message is safe for the dashboard and for clients. */
export class BlockedAddressError extends Error {}

// Never reachable, whatever the host name: the gateway itself, cloud metadata endpoints
// (169.254.169.254, fd00:ec2::254, Alibaba's 100.100.100.200) and addresses that are not unicast.
const ALWAYS_BLOCKED = new BlockList();
ALWAYS_BLOCKED.addSubnet('0.0.0.0', 8, 'ipv4');
ALWAYS_BLOCKED.addSubnet('127.0.0.0', 8, 'ipv4');
ALWAYS_BLOCKED.addSubnet('169.254.0.0', 16, 'ipv4');
ALWAYS_BLOCKED.addAddress('100.100.100.200', 'ipv4');
ALWAYS_BLOCKED.addSubnet('224.0.0.0', 3, 'ipv4');
ALWAYS_BLOCKED.addSubnet('::', 127, 'ipv6');
ALWAYS_BLOCKED.addSubnet('fe80::', 10, 'ipv6');
ALWAYS_BLOCKED.addAddress('fd00:ec2::254', 'ipv6');
ALWAYS_BLOCKED.addSubnet('ff00::', 8, 'ipv6');

// Private networks, which include the cluster's pod and Service ranges (10.42.0.0/16 and
// 10.43.0.0/16 on k3s), the node network and a VPS provider's internal network.
const PRIVATE = new BlockList();
PRIVATE.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE.addSubnet('192.168.0.0', 16, 'ipv4');
PRIVATE.addSubnet('100.64.0.0', 10, 'ipv4');
PRIVATE.addSubnet('fc00::', 7, 'ipv6');

/** A pattern from UpstreamNetworkPolicy.internalHosts as a regular expression for a whole host name. */
function hostPattern(pattern: string): RegExp {
  const escaped = pattern
    .toLowerCase()
    .split('*')
    .map((part) => part.replace(/[.]/g, '\\.'))
    .join('[a-z0-9-]*');
  return new RegExp(`^${escaped}$`);
}

/** IPv4-mapped IPv6 addresses (::ffff:10.0.0.1) are checked as the IPv4 address they carry. */
function normalized(address: string): { address: string; family: 'ipv4' | 'ipv6' } {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return { address: mapped[1]!, family: 'ipv4' };
  return { address, family: isIP(address) === 6 ? 'ipv6' : 'ipv4' };
}

/**
 * Why an upstream host may not be reached at a resolved address, or undefined when it may. Loopback,
 * link-local (cloud metadata) and non-unicast addresses are refused for every host; private and
 * cluster-internal addresses only for hosts that match no internal host pattern.
 */
export function addressRefusal(
  hostname: string,
  address: string,
  policy: UpstreamNetworkPolicy,
): string | undefined {
  const target = normalized(address);
  if (ALWAYS_BLOCKED.check(target.address, target.family)) {
    return 'the address is loopback, link-local or a cloud metadata endpoint, which upstreams may never use';
  }
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (
    PRIVATE.check(target.address, target.family) &&
    !policy.internalHosts.some((p) => hostPattern(p).test(host))
  ) {
    return 'the host resolves to a private or cluster-internal address and is not on the list of allowed internal hosts';
  }
  return undefined;
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * A DNS lookup for outgoing upstream connections that fails with BlockedAddressError when any
 * resolved address is refused. It runs for every connection, so a host that resolves to a public
 * address when the URL is saved and to an internal one later (DNS rebinding) is still refused.
 */
function guardedLookup(policy: UpstreamNetworkPolicy) {
  return (hostname: string, options: LookupOptions, callback: LookupCallback): void => {
    dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error, []);
      for (const { address } of addresses) {
        const refusal = addressRefusal(hostname, address, policy);
        if (refusal) return callback(new BlockedAddressError(refusal), []);
      }
      if (options.all) return callback(null, addresses);
      callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
}

/** The fetch signature the MCP client transport takes. */
export type UpstreamFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * A fetch for upstream MCP clients that only connects to addresses the policy allows. Host names are
 * checked as they resolve for each connection; an IP address in the URL is checked before the request.
 */
export function createGuardedFetch(policy: UpstreamNetworkPolicy): UpstreamFetch {
  const agent = new Agent({ connect: { lookup: guardedLookup(policy) } });
  return async (input, init) => {
    const url = new URL(input);
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(hostname)) {
      const refusal = addressRefusal(hostname, hostname, policy);
      if (refusal) throw new BlockedAddressError(refusal);
    }
    // undici's own fetch, so the dispatcher always matches it whatever undici Node bundles. Its types
    // differ from the DOM's in details the MCP transport does not use.
    const response = await undiciFetch(url, { ...(init as object), dispatcher: agent });
    return response as unknown as Response;
  };
}

/**
 * Checks an upstream URL when an admin saves it, so a refused address is reported on the form rather
 * than as Unreachable later. Returns the refusal, or undefined when every address it resolves to is
 * allowed. A host that does not resolve passes: it fails on its own, and may resolve later.
 */
export async function upstreamUrlRefusal(
  url: string,
  policy: UpstreamNetworkPolicy,
  lookup: (hostname: string) => Promise<string[]> = resolveAll,
): Promise<string | undefined> {
  const hostname = new URL(url).hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  try {
    addresses = isIP(hostname) ? [hostname] : await lookup(hostname);
  } catch {
    return undefined;
  }
  for (const address of addresses) {
    const refusal = addressRefusal(hostname, address, policy);
    if (refusal) return refusal;
  }
  return undefined;
}

function resolveAll(hostname: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true }, (error, addresses) =>
      error ? reject(error) : resolve(addresses.map((entry) => entry.address)),
    );
  });
}
