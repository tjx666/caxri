/**
 * The paired computer's current direct endpoint. A pairing link freezes the addresses the computer had when it was
 * paired; once the computer joins another network (a different Wi-Fi hands it a new LAN address), dialing those never
 * reaches it again and every connection falls back to the Relay. After each connection, over either route, the phone
 * reads the computer's current addresses with `mobile.computer.routes` and dials those from then on.
 */
import { isPrivateMobileIpv4Address } from '@caxri/mobile-transport';

import type { MobileCredential } from './credential-store';

export interface MobileDirectEndpoint {
    addresses: string[];
    port: number;
}

export interface MobileDirectEndpoints {
    load(serverId: string): Promise<MobileDirectEndpoint | undefined>;
    save(serverId: string, endpoint: MobileDirectEndpoint): void;
}

interface DirectEndpointStorage {
    getItemAsync(key: string): Promise<string | null>;
    setItemAsync(key: string, value: string): Promise<void>;
}

const DIRECT_ENDPOINT_KEY = 'caxri.mobile-direct-endpoint.v1';
const MAXIMUM_ADDRESSES = 8;

/**
 * Keeps only what the phone may dial: unique private IPv4 addresses and a valid port. Anything else yields `undefined`,
 * so the caller keeps the addresses it already had.
 */
export const sanitizeDirectEndpoint = (value: unknown): MobileDirectEndpoint | undefined => {
    if (!value || typeof value !== 'object' || !('addresses' in value) || !('port' in value))
        return undefined;
    const { addresses, port } = value;
    if (typeof port !== 'number' || !Array.isArray(addresses)) return undefined;
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return undefined;
    const usable = [
        ...new Set(
            addresses.filter(
                (address): address is string =>
                    typeof address === 'string' && isPrivateMobileIpv4Address(address),
            ),
        ),
    ].slice(0, MAXIMUM_ADDRESSES);
    return usable.length > 0 ? { addresses: usable, port } : undefined;
};

/**
 * Remembers the last endpoint per computer in memory and mirrors it to storage so a cold start dials the current
 * addresses. A storage failure only costs one connection over the paired addresses, so it is ignored.
 */
export const createMobileDirectEndpoints = (
    storage: DirectEndpointStorage,
): MobileDirectEndpoints => {
    let cached: { endpoint: MobileDirectEndpoint; serverId: string } | undefined;
    return {
        load: async (serverId) => {
            if (!cached) {
                try {
                    const stored = await storage.getItemAsync(DIRECT_ENDPOINT_KEY);
                    const parsed = stored ? (JSON.parse(stored) as unknown) : undefined;
                    if (
                        parsed &&
                        typeof parsed === 'object' &&
                        'serverId' in parsed &&
                        typeof parsed.serverId === 'string' &&
                        'endpoint' in parsed
                    ) {
                        const endpoint = sanitizeDirectEndpoint(parsed.endpoint);
                        if (endpoint) cached = { endpoint, serverId: parsed.serverId };
                    }
                } catch {
                    // Unreadable storage falls back to the paired addresses.
                }
            }
            return cached?.serverId === serverId ? cached.endpoint : undefined;
        },
        save: (serverId, endpoint) => {
            if (
                cached?.serverId === serverId &&
                cached.endpoint.port === endpoint.port &&
                cached.endpoint.addresses.join(',') === endpoint.addresses.join(',')
            )
                return;
            cached = { serverId, endpoint };
            void storage.setItemAsync(DIRECT_ENDPOINT_KEY, JSON.stringify(cached)).catch(() => {});
        },
    };
};

/**
 * The endpoint to dial: the last one the computer reported, else the one in the pairing credential.
 */
export const resolveDirectEndpoint = async (
    credential: Pick<MobileCredential, 'addresses' | 'port' | 'serverId'>,
    endpoints: MobileDirectEndpoints | undefined,
): Promise<MobileDirectEndpoint> =>
    (await endpoints?.load(credential.serverId)) ?? {
        addresses: credential.addresses,
        port: credential.port,
    };

/**
 * Asks the connected computer for its current endpoint and remembers it. A computer without the method (an older
 * build), a timeout, or a closed connection leaves the stored endpoint as it was.
 */
export const refreshDirectEndpoint = async (input: {
    endpoints: MobileDirectEndpoints | undefined;
    read: () => Promise<unknown>;
    serverId: string;
}): Promise<void> => {
    if (!input.endpoints) return;
    let result: unknown;
    try {
        result = await input.read();
    } catch {
        return;
    }
    const endpoint = sanitizeDirectEndpoint(result);
    if (endpoint) input.endpoints.save(input.serverId, endpoint);
};
