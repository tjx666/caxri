import { Buffer } from 'node:buffer';
import http from 'node:http';

import type { EnvironmentMonitorMihomoSettings } from '@caxri/protocol';
import { CaxriError, MAX_MIHOMO_CONTROLLER_NODES } from '@caxri/protocol';

const REQUEST_TIMEOUT_MS = 3_000;
const MAX_PROXIES_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_CONNECTIONS_RESPONSE_BYTES = 4 * 1024 * 1024;

const GROUP_PROXY_TYPES = new Set([
    'compatible',
    'fallback',
    'loadbalance',
    'relay',
    'selector',
    'urltest',
]);
const BUILTIN_PROXY_NAMES = new Set(['COMPATIBLE', 'DIRECT', 'PASS', 'REJECT', 'REJECT-DROP']);

export interface MihomoConnectionObservation {
    chains: string[];
    host: string;
    startedAt: number;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizedProxyType(value: unknown): string {
    return typeof value === 'string' ? value.replaceAll(/[^a-z]/giu, '').toLowerCase() : '';
}

export function parseMihomoNodes(payload: unknown): string[] {
    if (!isRecord(payload) || !isRecord(payload.proxies))
        throw new CaxriError('UNAVAILABLE', 'Mihomo Controller returned an invalid proxy list');
    return Object.entries(payload.proxies)
        .flatMap(([name, proxy]) => {
            if (
                !name ||
                name.length > 160 ||
                BUILTIN_PROXY_NAMES.has(name.toUpperCase()) ||
                !isRecord(proxy) ||
                GROUP_PROXY_TYPES.has(normalizedProxyType(proxy.type))
            )
                return [];
            return [name];
        })
        .toSorted((left, right) => left.localeCompare(right))
        .slice(0, MAX_MIHOMO_CONTROLLER_NODES);
}

export function parseMihomoConnections(
    payload: unknown,
    fallbackStartedAt: number,
): MihomoConnectionObservation[] {
    if (!isRecord(payload) || !Array.isArray(payload.connections))
        throw new CaxriError(
            'UNAVAILABLE',
            'Mihomo Controller returned an invalid connection list',
        );
    return payload.connections.flatMap((connection) => {
        if (!isRecord(connection) || !isRecord(connection.metadata)) return [];
        const rawHost = connection.metadata.host;
        if (typeof rawHost !== 'string') return [];
        const host = rawHost.trim().toLowerCase().replace(/\.$/u, '');
        if (!host || host.length > 253 || !Array.isArray(connection.chains)) return [];
        const chains = connection.chains.filter(
            (chain): chain is string =>
                typeof chain === 'string' && chain.length > 0 && chain.length <= 160,
        );
        if (chains.length === 0) return [];
        const parsedStartedAt =
            typeof connection.start === 'string' ? Date.parse(connection.start) : NaN;
        return [
            {
                chains: chains.slice(0, 16),
                host,
                startedAt: Number.isFinite(parsedStartedAt) ? parsedStartedAt : fallbackStartedAt,
            },
        ];
    });
}

function controllerRequestOptions(
    settings: EnvironmentMonitorMihomoSettings,
    path: '/connections' | '/proxies',
): http.RequestOptions {
    const headers = settings.secret ? { Authorization: `Bearer ${settings.secret}` } : undefined;
    if (settings.endpoint.startsWith('unix://'))
        return {
            headers,
            method: 'GET',
            path,
            socketPath: settings.endpoint.slice('unix://'.length),
        };
    const endpoint = new URL(settings.endpoint);
    return {
        headers,
        hostname: endpoint.hostname === '[::1]' ? '::1' : endpoint.hostname,
        method: 'GET',
        path,
        port: endpoint.port || 80,
        protocol: 'http:',
    };
}

function requestControllerJson(
    settings: EnvironmentMonitorMihomoSettings,
    path: '/connections' | '/proxies',
    maximumBytes: number,
): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const request = http.request(controllerRequestOptions(settings, path), (response) => {
            const chunks: Buffer[] = [];
            let receivedBytes = 0;
            response.on('data', (chunk: Buffer) => {
                receivedBytes += chunk.length;
                if (receivedBytes > maximumBytes) {
                    request.destroy();
                    reject(
                        new CaxriError('UNAVAILABLE', 'Mihomo Controller response is too large'),
                    );
                    return;
                }
                chunks.push(chunk);
            });
            response.on('end', () => {
                if (response.statusCode === 401 || response.statusCode === 403) {
                    reject(new CaxriError('UNAVAILABLE', 'Mihomo Controller rejected the secret'));
                    return;
                }
                if (
                    !response.statusCode ||
                    response.statusCode < 200 ||
                    response.statusCode >= 300
                ) {
                    reject(new CaxriError('UNAVAILABLE', 'Mihomo Controller request failed'));
                    return;
                }
                try {
                    resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
                } catch {
                    reject(
                        new CaxriError('UNAVAILABLE', 'Mihomo Controller returned invalid JSON'),
                    );
                }
            });
            response.on('error', () => {
                reject(new CaxriError('UNAVAILABLE', 'Mihomo Controller response was interrupted'));
            });
        });
        request.setTimeout(REQUEST_TIMEOUT_MS, () => {
            request.destroy(new Error('timeout'));
        });
        request.on('error', () => {
            reject(new CaxriError('UNAVAILABLE', 'Cannot reach the local Mihomo Controller'));
        });
        request.end();
    });
}

export async function readMihomoNodes(
    settings: EnvironmentMonitorMihomoSettings,
): Promise<string[]> {
    return parseMihomoNodes(
        await requestControllerJson(settings, '/proxies', MAX_PROXIES_RESPONSE_BYTES),
    );
}

export async function readMihomoConnections(
    settings: EnvironmentMonitorMihomoSettings,
    now: number,
): Promise<MihomoConnectionObservation[]> {
    return parseMihomoConnections(
        await requestControllerJson(settings, '/connections', MAX_CONNECTIONS_RESPONSE_BYTES),
        now,
    );
}
