import { readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';

import { readCappedBody } from '@caxri/system';

import type {
    EnvironmentEgressReading,
    EnvironmentMonitorProbe,
    EnvironmentMonitorProbeReading,
} from './types';
import { requiresExternalEnvironmentProbe } from './types';

const FETCH_TIMEOUT_MS = 8_000;
const LOCAL_PROXY_TIMEOUT_MS = 750;
const MAX_RESPONSE_BYTES = 64 * 1_024;

interface ProbeSource {
    normalize(text: string): EnvironmentEgressReading | undefined;
    url: string;
}

const IP_SOURCES: readonly ProbeSource[] = [
    {
        url: 'https://api.ipify.org?format=json',
        normalize: (text) => {
            const ip = safeText(objectRecord(parseJson(text))?.ip, 64);
            return ip ? { ip } : undefined;
        },
    },
    {
        url: 'https://api64.ipify.org?format=json',
        normalize: (text) => {
            const ip = safeText(objectRecord(parseJson(text))?.ip, 64);
            return ip ? { ip } : undefined;
        },
    },
    {
        url: 'https://api.ip.sb/ip',
        normalize: (text) => {
            const ip = safeText(text, 64);
            return ip ? { ip } : undefined;
        },
    },
];

const GEO_SOURCES: readonly ProbeSource[] = [
    {
        url: 'https://ipinfo.io/json',
        normalize: (text) => {
            const row = objectRecord(parseJson(text));
            const ip = safeText(row?.ip, 64);
            if (!ip) return;
            return {
                ip,
                countryCode: countryCode(row?.country),
                region: joinRegion(row?.city, row?.region, row?.country),
                network: safeText(row?.org, 160),
                timeZone: timeZone(row?.timezone),
            };
        },
    },
    {
        url: 'https://ipapi.co/json/',
        normalize: (text) => {
            const row = objectRecord(parseJson(text));
            const ip = safeText(row?.ip, 64);
            if (!ip) return;
            return {
                ip,
                countryCode: countryCode(row?.country_code),
                region: joinRegion(row?.city, row?.region, row?.country_code),
                network: joinNetwork(row?.asn, row?.org),
                timeZone: timeZone(row?.timezone),
            };
        },
    },
    {
        url: 'https://api.ip.sb/geoip',
        normalize: (text) => {
            const row = objectRecord(parseJson(text));
            const ip = safeText(row?.ip, 64);
            if (!ip) return;
            return {
                ip,
                countryCode: countryCode(row?.country_code),
                region: joinRegion(row?.city, row?.region, row?.country_code),
                network: joinNetwork(
                    row?.asn,
                    row?.asn_organization ?? row?.organization ?? row?.isp,
                ),
                timeZone: timeZone(row?.timezone),
            };
        },
    },
];

function parseJson(text: string): unknown {
    return JSON.parse(text);
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function safeText(value: unknown, limit: number): string | undefined {
    if (typeof value !== 'string' && typeof value !== 'number') return undefined;
    const text = [...String(value)]
        .map((character) => {
            const code = character.codePointAt(0) ?? 0;
            return code === 0x7f || code <= 0x1f ? ' ' : character;
        })
        .join('')
        .trim();
    return text ? text.slice(0, limit) : undefined;
}

function countryCode(value: unknown): string | undefined {
    const code = safeText(value, 2)?.toUpperCase();
    return code && /^[A-Z]{2}$/u.test(code) ? code : undefined;
}

function joinRegion(city: unknown, region: unknown, country: unknown): string | undefined {
    const value = [safeText(city, 80), safeText(region, 80), countryCode(country)]
        .filter((part): part is string => Boolean(part))
        .join(', ');
    return value ? value.slice(0, 160) : undefined;
}

function joinNetwork(asn: unknown, organization: unknown): string | undefined {
    const rawAsn = safeText(asn, 24);
    const normalizedAsn = rawAsn && /^\d+$/u.test(rawAsn) ? `AS${rawAsn}` : rawAsn;
    const value = [normalizedAsn, safeText(organization, 130)]
        .filter((part): part is string => Boolean(part))
        .join(' ');
    return value ? value.slice(0, 160) : undefined;
}

function timeZone(value: unknown): string | undefined {
    const candidate = safeText(value, 64);
    if (!candidate) return undefined;
    try {
        // react-doctor-disable-next-line react-doctor/js-hoist-intl -- The untrusted time-zone candidate changes with each public response and must be validated before use.
        return new Intl.DateTimeFormat('en-US', { timeZone: candidate }).resolvedOptions().timeZone;
    } catch {
        return undefined;
    }
}

export function normalizeProxyRoute(route: string): string {
    return route
        .split(';')
        .map((part) => part.trim().replaceAll(/\s+/gu, ' ').toUpperCase())
        .filter(Boolean)
        .join(';');
}

interface ProxyEndpoint {
    host: string;
    port: number;
}

function loopbackProxyEndpoint(route: string): ProxyEndpoint | undefined {
    for (const part of normalizeProxyRoute(route).split(';')) {
        const separator = part.indexOf(' ');
        if (separator === -1 || !/^(?:PROXY|HTTPS?|SOCKS\d?|QUIC)$/u.test(part.slice(0, separator)))
            continue;
        const address = part.slice(separator + 1);
        const portSeparator = address.lastIndexOf(':');
        if (portSeparator < 1) continue;
        const host = address
            .slice(0, portSeparator)
            .replaceAll(/^\[|\]$/gu, '')
            .toLowerCase();
        if (host !== 'localhost' && host !== '::1' && !/^127(?:\.\d{1,3}){3}$/u.test(host))
            continue;
        const port = Number(address.slice(portSeparator + 1));
        if (Number.isSafeInteger(port) && port > 0 && port <= 65_535) return { host, port };
    }
    return undefined;
}

export function checkLoopbackProxy(endpoint: ProxyEndpoint, signal: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
        let isSettled = false;
        const socket = createConnection({ host: endpoint.host, port: endpoint.port });
        let cleanup = (): void => {};
        const finish = (isAvailable: boolean): void => {
            if (isSettled) return;
            isSettled = true;
            cleanup();
            socket.destroy();
            resolve(isAvailable);
        };
        const onAbort = (): void => finish(false);
        const timer = setTimeout(() => finish(false), LOCAL_PROXY_TIMEOUT_MS);
        cleanup = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
        };
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

async function readResponse(response: Response): Promise<string> {
    const chunks: Uint8Array[] = [];
    const end = await readCappedBody(response, MAX_RESPONSE_BYTES, (chunk) => {
        chunks.push(chunk);
    });
    if (end === 'limit') throw new Error('Environment response exceeded the size limit');
    const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export function createLiveEnvironmentMonitorProbe(options: {
    checkLocalProxy?: typeof checkLoopbackProxy;
    fetch: typeof fetch;
    resolveProxy: (url: string) => Promise<string>;
}): EnvironmentMonitorProbe {
    const checkLocalProxy = options.checkLocalProxy ?? checkLoopbackProxy;
    return async (signals, signal) => {
        const sources =
            signals.locationChanges || signals.timeZoneMismatch ? GEO_SOURCES : IP_SOURCES;
        const needsExternalProbe = requiresExternalEnvironmentProbe(signals);
        let lastError: unknown;
        const attempt = async (index: number): Promise<EnvironmentMonitorProbeReading> => {
            if (index >= sources.length)
                throw lastError instanceof Error
                    ? lastError
                    : new Error('No environment source was available', { cause: lastError });
            const source = sources[index];
            try {
                const proxyRoute = signals.proxyProtection
                    ? normalizeProxyRoute(await options.resolveProxy(source.url))
                    : undefined;
                const endpoint = proxyRoute ? loopbackProxyEndpoint(proxyRoute) : undefined;
                const proxyAvailable = endpoint
                    ? await checkLocalProxy(endpoint, signal)
                    : undefined;
                if (proxyAvailable === false)
                    return { proxy: { route: proxyRoute ?? '', available: false } };
                if (!needsExternalProbe)
                    return {
                        ...(proxyRoute !== undefined && {
                            proxy: { route: proxyRoute, available: proxyAvailable },
                        }),
                    };
                const response = await options.fetch(source.url, {
                    cache: 'no-store',
                    credentials: 'omit',
                    headers: { Accept: 'application/json, text/plain;q=0.9' },
                    signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
                });
                if (!response.ok)
                    throw new Error(`Environment source returned HTTP ${response.status}`);
                const egress = source.normalize(await readResponse(response));
                if (!egress) throw new Error('Environment source returned an invalid response');
                return {
                    egress,
                    ...(proxyRoute !== undefined && {
                        proxy: { route: proxyRoute, available: proxyAvailable },
                    }),
                };
            } catch (error) {
                if (signal.aborted) throw error;
                lastError = error;
                return attempt(index + 1);
            }
        };
        return attempt(0);
    };
}

/**
 * Deterministic, synthetic-only probe for Electron E2E. The file is read on every refresh so a test can move from a
 * healthy baseline to a warning without restarting the app.
 */
export function createE2EEnvironmentMonitorProbe(path: string): EnvironmentMonitorProbe {
    return async () => {
        const value: unknown = JSON.parse(await readFile(path, 'utf8'));
        const row = objectRecord(value);
        const ip = safeText(row?.ip, 64);
        if (!row || !ip) throw new Error('The environment monitor E2E fixture is invalid');
        return {
            egress: {
                ip,
                countryCode: countryCode(row.countryCode),
                region: safeText(row.region, 160),
                network: safeText(row.network, 160),
                timeZone: timeZone(row.timeZone),
            },
            proxy: {
                route: safeText(row.proxyRoute, 512) ?? 'DIRECT',
                ...(typeof row.proxyAvailable === 'boolean' && {
                    available: row.proxyAvailable,
                }),
            },
        };
    };
}
