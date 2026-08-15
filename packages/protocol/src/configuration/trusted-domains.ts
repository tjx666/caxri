export const MAX_TRUSTED_DOMAINS = 128;
export const MAX_TRUSTED_DOMAIN_LENGTH = 512;

type ExternalUrlRejectionReason =
    'invalid_url' | 'unsupported_protocol' | 'credentials_not_allowed';

export type ExternalHttpUrlResult =
    { ok: true; url: URL } | { ok: false; reason: ExternalUrlRejectionReason };

function normalizedHostname(hostname: string): string | undefined {
    if (!hostname.endsWith('.')) return hostname;
    const normalized = hostname.slice(0, -1);
    return !normalized || normalized.endsWith('.') ? undefined : normalized;
}

function canonicalizeUrl(url: URL): URL | undefined {
    const hostname = normalizedHostname(url.hostname);
    if (!hostname) return;
    if (hostname === url.hostname) return url;
    const canonical = new URL(url.href);
    canonical.hostname = hostname;
    return canonical;
}

/**
Parses the only URL class Caxri may send to the operating system.
 */
export function parseExternalHttpUrl(input: string): ExternalHttpUrlResult {
    let parsed: URL;
    try {
        parsed = new URL(input);
    } catch {
        return { ok: false, reason: 'invalid_url' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
        return { ok: false, reason: 'unsupported_protocol' };
    if (parsed.username || parsed.password) return { ok: false, reason: 'credentials_not_allowed' };
    if (!parsed.hostname || parsed.hostname.includes('*'))
        return { ok: false, reason: 'invalid_url' };
    const canonical = canonicalizeUrl(parsed);
    return canonical ? { ok: true, url: canonical } : { ok: false, reason: 'invalid_url' };
}

/**
Returns a canonical exact-origin rule without path, query, fragment, or user information.
 */
export function externalUrlOrigin(url: URL): string {
    const canonical = canonicalizeUrl(url);
    if (!canonical) return '';
    return `${canonical.protocol}//${canonical.hostname}${canonical.port ? `:${canonical.port}` : ''}`;
}

function isIpHostname(hostname: string): boolean {
    return hostname.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(hostname);
}

function hasOriginOnly(url: URL): boolean {
    return !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
}

/**
Canonicalizes one persisted exact-origin or explicit subdomain-wildcard rule.
 */
export function normalizeTrustedDomainRule(input: string): string | undefined {
    const value = input.trim();
    if (!value || value.length > MAX_TRUSTED_DOMAIN_LENGTH) return;
    const wildcard = /^(https?):\/\/\*\.(.+)$/i.exec(value);
    if (wildcard) {
        let parsed: URL;
        try {
            parsed = new URL(`${wildcard[1].toLowerCase()}://${wildcard[2]}`);
        } catch {
            return;
        }
        const canonical = canonicalizeUrl(parsed);
        if (
            !canonical ||
            !hasOriginOnly(canonical) ||
            isIpHostname(canonical.hostname) ||
            !canonical.hostname.includes('.')
        )
            return;
        return `${canonical.protocol}//*.${canonical.hostname}${canonical.port ? `:${canonical.port}` : ''}`;
    }

    const parsed = parseExternalHttpUrl(value);
    if (!parsed.ok || !hasOriginOnly(parsed.url)) return;
    return externalUrlOrigin(parsed.url);
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

function isLoopback(hostname: string): boolean {
    return LOOPBACK_HOSTNAMES.has(hostname);
}

/**
Matches Main-validated URLs against bounded, independently normalized persisted rules.
 */
export function isExternalUrlTrusted(url: URL, rules: readonly string[]): boolean {
    const origin = externalUrlOrigin(url);
    if (!origin || isLoopback(url.hostname)) return Boolean(origin);
    for (const input of rules.slice(0, MAX_TRUSTED_DOMAINS)) {
        const rule = normalizeTrustedDomainRule(input);
        if (!rule) continue;
        if (!rule.includes('://*.')) {
            if (rule === origin) return true;
            continue;
        }
        const parsed = new URL(rule.replace('://*.', '://'));
        if (parsed.protocol !== url.protocol || parsed.port !== url.port) continue;
        if (url.hostname === parsed.hostname || url.hostname.endsWith(`.${parsed.hostname}`))
            return true;
    }
    return false;
}
