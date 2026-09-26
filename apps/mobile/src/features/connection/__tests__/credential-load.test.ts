import { describe, expect, it } from 'vitest';

import { loadMobileCredential } from '../credential-load';
import type { MobileCredential } from '../credential-store';

describe('mobile credential load', () => {
    it('distinguishes empty storage from a rejected native read', async () => {
        await expect(loadMobileCredential({ load: () => Promise.resolve(null) })).resolves.toEqual({
            kind: 'loaded',
            credential: null,
        });
        await expect(
            loadMobileCredential({
                load: () => Promise.reject(new Error('private native storage details')),
            }),
        ).resolves.toEqual({ kind: 'storage-error' });
    });

    it('preserves a valid credential for reconnection', async () => {
        const credential = { deviceId: 'device-1' } as MobileCredential;
        await expect(
            loadMobileCredential({ load: () => Promise.resolve(credential) }),
        ).resolves.toEqual({
            kind: 'loaded',
            credential,
        });
    });
});
