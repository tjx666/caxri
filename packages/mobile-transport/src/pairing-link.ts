import type { MobilePairingLink } from './contract.js';
import { mobilePairingLinkSchema } from './contract.js';

const expectedParameters = [
    'addresses',
    'expires',
    'pairing',
    'port',
    'secret',
    'server',
    'v',
] as const;

export const serializeMobilePairingLink = (input: MobilePairingLink): string => {
    const value = mobilePairingLinkSchema.parse(input);
    const parameters = new URLSearchParams({
        addresses: value.addresses.join(','),
        expires: String(value.expiresAt),
        pairing: value.pairingId,
        port: String(value.port),
        secret: value.secret,
        server: value.serverId,
        v: String(value.version),
    });
    return `caxri://pair?${parameters.toString()}`;
};

export const parseMobilePairingLink = (source: string): MobilePairingLink => {
    if (source.length > 2_048) throw new Error('Pairing link is too long');
    const url = new URL(source);
    if (
        url.protocol !== 'caxri:' ||
        url.hostname !== 'pair' ||
        (url.pathname && url.pathname !== '/')
    )
        throw new Error('Expected a Caxri pairing link');
    let parameterCount = 0;
    const keys = new Set<string>();
    for (const key of url.searchParams.keys()) {
        parameterCount += 1;
        keys.add(key);
    }
    if (
        parameterCount !== expectedParameters.length ||
        keys.size !== expectedParameters.length ||
        expectedParameters.some((parameter) => !keys.has(parameter))
    )
        throw new Error('Pairing link parameters do not match the protocol');
    return mobilePairingLinkSchema.parse({
        version: Number(url.searchParams.get('v')),
        addresses: url.searchParams.get('addresses')?.split(','),
        port: Number(url.searchParams.get('port')),
        serverId: url.searchParams.get('server'),
        pairingId: url.searchParams.get('pairing'),
        secret: url.searchParams.get('secret'),
        expiresAt: Number(url.searchParams.get('expires')),
    });
};
