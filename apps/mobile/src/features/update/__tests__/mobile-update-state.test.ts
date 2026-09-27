import type { MobileUpdatePrepareResult } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { MobileUpdateInstallPorts, MobileUpdatePhase } from '../mobile-update-state';
import {
    installMobileUpdate,
    mobileUpdateSizeLabel,
    mobileUpdateStatusLabel,
    mobileUpdateStore,
    newerMobileUpdate,
} from '../mobile-update-state';

const bundle = {
    version: '0.0.75',
    versionCode: 75,
    sizeBytes: 42 * 1_024 * 1_024,
    md5: 'a'.repeat(32),
};
const prepared: MobileUpdatePrepareResult = {
    bundle,
    expiresAt: 1_788_106_000_000,
    url: `http://192.0.2.1:4000/mobile/update/${'b'.repeat(64)}`,
};

const ports = (
    overrides: Partial<Awaited<ReturnType<MobileUpdateInstallPorts['download']>>> = {},
) => {
    const discard = vi.fn();
    const launchInstaller = vi.fn<MobileUpdateInstallPorts['launchInstaller']>(() =>
        Promise.resolve(),
    );
    const value: MobileUpdateInstallPorts = {
        prepare: () => Promise.resolve(prepared),
        download: (_prepared, onProgress) => {
            onProgress(0.5);
            onProgress(0.501);
            onProgress(1.2);
            return Promise.resolve({
                contentUri: 'content://update.apk',
                discard,
                md5: bundle.md5,
                sizeBytes: bundle.sizeBytes,
                ...overrides,
            });
        },
        launchInstaller,
    };
    return { discard, launchInstaller, value };
};

describe('newerMobileUpdate', () => {
    it('offers only a strictly newer bundle for a known installed build', () => {
        expect(newerMobileUpdate(74, bundle)).toBe(bundle);
        expect(newerMobileUpdate(75, bundle)).toBeUndefined();
        expect(newerMobileUpdate(76, bundle)).toBeUndefined();
        expect(newerMobileUpdate(undefined, bundle)).toBeUndefined();
        expect(newerMobileUpdate(74, null)).toBeUndefined();
    });
});

describe('installMobileUpdate', () => {
    it('reports clamped progress and opens the installer for a verified download', async () => {
        const { launchInstaller, value } = ports();
        const phases: MobileUpdatePhase[] = [];

        await installMobileUpdate(value, (phase) => phases.push(phase));

        expect(phases).toEqual([
            { kind: 'downloading', fraction: 0 },
            { kind: 'downloading', fraction: 0.5 },
            { kind: 'downloading', fraction: 1 },
            { kind: 'installing' },
            { kind: 'idle' },
        ]);
        expect(launchInstaller).toHaveBeenCalledWith('content://update.apk');
    });

    it('discards a download whose checksum does not match and never opens the installer', async () => {
        const { discard, launchInstaller, value } = ports({ md5: 'c'.repeat(32) });
        const phases: MobileUpdatePhase[] = [];

        await installMobileUpdate(value, (phase) => phases.push(phase));

        expect(discard).toHaveBeenCalledOnce();
        expect(launchInstaller).not.toHaveBeenCalled();
        expect(phases.at(-1)).toEqual({
            kind: 'failed',
            message: 'The download was incomplete. Try again.',
        });
    });

    it('turns a transport failure into a retryable message', async () => {
        const { value } = ports();
        const phases: MobileUpdatePhase[] = [];

        await installMobileUpdate(
            { ...value, prepare: () => Promise.reject(new Error('socket closed')) },
            (phase) => phases.push(phase),
        );

        expect(phases.at(-1)).toMatchObject({ kind: 'failed' });
        expect(mobileUpdateStatusLabel(phases.at(-1)!)).toMatch(/try again/u);
    });
});

describe('labels', () => {
    it('formats size and progress for the update row', () => {
        expect(mobileUpdateSizeLabel(bundle.sizeBytes)).toBe('42 MB');
        expect(mobileUpdateSizeLabel(10)).toBe('1 MB');
        expect(mobileUpdateStatusLabel({ kind: 'downloading', fraction: 0.456 })).toBe(
            'Downloading 45%',
        );
        expect(mobileUpdateStatusLabel({ kind: 'idle' })).toBeUndefined();
    });
});

describe('mobileUpdateStore', () => {
    it('publishes phase and dismissal as a new snapshot', () => {
        const listener = vi.fn();
        const unsubscribe = mobileUpdateStore.subscribe(listener);
        const before = mobileUpdateStore.get();

        mobileUpdateStore.dismiss(75);
        mobileUpdateStore.setPhase({ kind: 'installing' });

        expect(mobileUpdateStore.get()).not.toBe(before);
        expect(mobileUpdateStore.get()).toEqual({
            dismissedVersionCode: 75,
            phase: { kind: 'installing' },
        });
        expect(listener).toHaveBeenCalledTimes(2);
        unsubscribe();
    });
});
