import { BlockList, isIP } from 'node:net';

/**
 * One HTTP exchange that never follows a redirect: a 3xx answer comes back as a response carrying its `location`, so
 * the caller can vet the target before anything is sent there.
 */
export type ManualRedirectFetch = (
    url: string,
    init: { signal: AbortSignal; headers?: Record<string, string> },
) => Promise<Response>;

/**
 * Every address a hostname resolves to. A rejection means this machine could not resolve the host; the request may
 * still succeed through a proxy that resolves names itself.
 */
export type ResolveHost = (hostname: string) => Promise<readonly string[]>;

/**
 * The response of the last hop and the URL it came from, or `undefined` when the policy refused a hop before it was
 * requested.
 */
export type PublicFetchResult = { response: Response; url: string } | undefined;

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Addresses that reach this machine or its local networks rather than the public internet: unspecified, loopback, RFC
 * 1918 private, carrier-grade NAT (also Tailscale's range), link-local (including the cloud metadata address), IETF
 * protocol assignments, multicast, and reserved space, plus their IPv6 counterparts. IPv4 rules also match the
 * IPv4-mapped IPv6 form. `198.18.0.0/15` is deliberately absent: proxy clients in fake-IP mode answer every public
 * hostname from it, and refusing it would hide every preview behind such a proxy.
 */
const internalAddresses = new BlockList();
for (const [network, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.168.0.0', 16],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
] as const) {
    internalAddresses.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
    ['::', 128],
    ['::1', 128],
    ['fc00::', 7],
    ['fe80::', 10],
    ['ff00::', 8],
] as const) {
    internalAddresses.addSubnet(network, prefix, 'ipv6');
}

/**
 * Whether an IP literal is on the public internet. A string that is not an IP address is not public.
 */
export function isPublicAddress(address: string): boolean {
    const family = isIP(address);
    if (family === 0) return false;
    return !internalAddresses.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * Whether a URL may be requested on the user's behalf without a click: HTTPS, and a host that is, or resolves only to,
 * public addresses. `localhost` and its subdomains are refused without a lookup because the resolver may special-case
 * them. A failed lookup falls back to that URL-only check and allows the request: behind an HTTP or PAC proxy on a
 * network without outside DNS, Chromium hands the hostname to the proxy instead of resolving it, so the local lookup
 * fails while the request succeeds. A name this machine cannot resolve also cannot make a direct connection reach a
 * local service, and when the network is down the request itself fails and the caller retries.
 */
async function isPublicHttpsUrl(url: URL, resolveHost: ResolveHost): Promise<boolean> {
    if (url.protocol !== 'https:') return false;
    // WHATWG URL keeps IPv6 literals bracketed and already normalizes shorthand IPv4 such as `2130706433`.
    const hostname = url.hostname.replace(/^\[(.*)\]$/u, '$1').toLowerCase();
    if (isIP(hostname) !== 0) return isPublicAddress(hostname);
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) return false;
    let addresses: readonly string[];
    try {
        addresses = await resolveHost(hostname);
    } catch {
        return true;
    }
    return addresses.length > 0 && addresses.every(isPublicAddress);
}

/**
 * Fetches a URL Main requests without a user's click (link favicons and hover previews), refusing any hop whose URL is
 * not public HTTPS. Redirects are followed one hop at a time so each target is vetted before it is requested, which
 * keeps a public link from bouncing the request to a loopback or private service. The host is resolved before the
 * request rather than pinned to the connection, so DNS rebinding between the two lookups is out of scope: Caxri's bar
 * is a single user on their own machine, and the goal is that a rendered or hovered link cannot reach local services by
 * name or address. A failed lookup does not refuse the hop (see `isPublicHttpsUrl`); a failed request rejects, so the
 * caller can retry instead of remembering a refusal.
 */
export function createPublicHttpsFetch(fetch: ManualRedirectFetch, resolveHost: ResolveHost) {
    return async (
        url: string,
        init: { signal: AbortSignal; headers?: Record<string, string> },
    ): Promise<PublicFetchResult> => {
        let current = new URL(url);
        for (let hop = 0; ; hop += 1) {
            // eslint-disable-next-line no-await-in-loop -- each hop is vetted only after the previous one answered
            if (!(await isPublicHttpsUrl(current, resolveHost))) return undefined;
            // eslint-disable-next-line no-await-in-loop -- redirects are inherently sequential
            const response = await fetch(current.href, init);
            const location = response.headers.get('location');
            if (location === null || !REDIRECT_STATUSES.has(response.status)) {
                return { response, url: current.href };
            }
            // eslint-disable-next-line no-void -- a redirect body carries nothing the caller reads
            void response.body?.cancel().catch(() => {});
            if (hop === MAX_REDIRECTS) return undefined;
            try {
                current = new URL(location, current);
            } catch {
                return undefined;
            }
        }
    };
}

export type PublicHttpsFetch = ReturnType<typeof createPublicHttpsFetch>;
