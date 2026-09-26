import type { MobileCredential } from './credential-store';

export const pairingCredential = (
    link: { addresses: string[]; port: number; serverId: string },
    paired: { credential: string; deviceId: string; generation: number },
): MobileCredential => ({
    version: 1,
    addresses: link.addresses,
    port: link.port,
    serverId: link.serverId,
    deviceId: paired.deviceId,
    generation: paired.generation,
    credential: paired.credential,
});
