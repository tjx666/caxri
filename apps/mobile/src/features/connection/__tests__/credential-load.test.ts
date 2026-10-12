import { describe, expect, it, vi } from 'vitest';

import { loadMobileCredential, loadMobileCredentialAtStart } from '../credential-load';
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

describe('mobile credential load at start', () => {
    it('clears the read cache when no pairing survived, such as a revoke the app was killed during', async () => {
        const readCache = { clear: vi.fn() };
        await expect(
            loadMobileCredentialAtStart({ load: () => Promise.resolve(null) }, readCache),
        ).resolves.toEqual({ kind: 'loaded', credential: null });
        expect(readCache.clear).toHaveBeenCalledOnce();
    });

    it('keeps the read cache for a stored pairing or an unreadable store', async () => {
        const readCache = { clear: vi.fn() };
        const credential = { deviceId: 'device-1' } as MobileCredential;
        await loadMobileCredentialAtStart({ load: () => Promise.resolve(credential) }, readCache);
        await loadMobileCredentialAtStart(
            { load: () => Promise.reject(new Error('locked')) },
            readCache,
        );
        expect(readCache.clear).not.toHaveBeenCalled();
    });
});
