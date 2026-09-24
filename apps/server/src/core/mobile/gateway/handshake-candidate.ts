import { Buffer } from 'node:buffer';

import type { MobileClientHello } from '@caxri/mobile-transport';
import { PAIRING_SECRET_BYTES } from '@caxri/mobile-transport';

import type { MobileDeviceRecord } from '../device-registry';

/**
 * Preserves one challenge shape for invalid pairing IDs without disclosing whether one exists.
 */
export function dummyCandidate(
    hello: Extract<MobileClientHello, { mode: 'pair' }>,
    now: number,
    random: (bytes: number) => Uint8Array,
): MobileDeviceRecord {
    return {
        deviceId: `device_${Buffer.from(random(16)).toString('hex')}`,
        displayName: hello.displayName,
        platform: hello.platform,
        credential: Buffer.from(random(PAIRING_SECRET_BYTES)).toString('hex'),
        generation: 1,
        role: 'control',
        projectIds: ['invalid-pairing'],
        createdAt: now,
    };
}
