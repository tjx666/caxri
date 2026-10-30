import type { MobileUpdatePrepareResult } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { MobileUpdateInstallPorts, MobileUpdatePhase } from '../mobile-update-state';
import {
    installMobileUpdate,
    mobileUpdateBannerKind,
    mobileUpdateBannerView,
    mobileUpdateCheckLabel,
    mobileUpdateCheckStatus,
    mobileUpdateNoticeView,
    mobileUpdateSizeLabel,
    mobileUpdateStatusLabel,
    mobileUpdateStore,
    newerMobileUpdate,
    preparedMobileUpdateFromRecovery,
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

describe('mobileUpdateBannerKind', () => {
    const idle: MobileUpdatePhase = { kind: 'idle' };
    const base = {
        canRetryCheck: false,
        isChecking: false,
        isDismissed: false,
        isRecovering: false,
        phase: idle,
        status: 'connected' as const,
        update: bundle,
    };

    it('offers a dismissible update while connected and hides it after Later', () => {
        expect(mobileUpdateBannerKind(base)).toBe('available');
        expect(mobileUpdateBannerKind({ ...base, isDismissed: true })).toBeNull();
        expect(
            mobileUpdateBannerKind({
                ...base,
                isDismissed: true,
                phase: { kind: 'downloading', fraction: 0.4 },
            }),
        ).toBe('available');
        expect(mobileUpdateBannerKind({ ...base, update: undefined })).toBeNull();
    });

    it('requires the newer Desktop build during a mismatch and ignores Later', () => {
        const mismatch = { ...base, isRecovering: true, status: 'version-mismatch' as const };
        expect(mobileUpdateBannerKind(mismatch)).toBe('required');
        expect(mobileUpdateBannerKind({ ...mismatch, isDismissed: true })).toBe('required');
        expect(mobileUpdateBannerKind({ ...mismatch, isChecking: true, update: undefined })).toBe(
            'checking',
        );
    });

    it('offers to ask again when recovery could not reach the newer Desktop', () => {
        const failed = {
            ...base,
            canRetryCheck: true,
            isRecovering: true,
            status: 'version-mismatch' as const,
            update: undefined,
        };
        expect(mobileUpdateBannerKind(failed)).toBe('unreachable');
        expect(mobileUpdateBannerKind({ ...failed, isChecking: true })).toBe('checking');
        // A rejected pairing is not retryable; asking again cannot change the answer.
        expect(mobileUpdateBannerKind({ ...failed, canRetryCheck: false })).toBe('mismatch');
    });

    it('falls back to the manual mismatch notice when recovery has no newer build', () => {
        const mismatch = { ...base, status: 'version-mismatch' as const, update: undefined };
        expect(mobileUpdateBannerKind(mismatch)).toBe('mismatch');
        expect(mobileUpdateBannerKind({ ...mismatch, isRecovering: true })).toBe('mismatch');
        // An older Desktop cannot hold the fix, so a stale connected-mode offer never turns into a requirement.
        expect(mobileUpdateBannerKind({ ...mismatch, update: bundle })).toBe('mismatch');
    });
});

describe('mobileUpdateBannerView', () => {
    const idle: MobileUpdatePhase = { kind: 'idle' };

    it('offers a dismissible update while connected', () => {
        expect(mobileUpdateBannerView('available', idle, bundle)).toEqual({
            action: 'install',
            actionLabel: 'Update',
            canDismiss: true,
            detail: 'Version 0.0.75 from your computer · 42 MB',
            isFailure: false,
            isRequired: false,
            title: 'Update available',
        });
    });

    it('requires the update without Later and hides actions while busy', () => {
        expect(mobileUpdateBannerView('required', idle, bundle)).toMatchObject({
            action: 'install',
            canDismiss: false,
            detail: 'This computer runs a newer Caxri. Update this app to reconnect.',
            title: 'Update required',
        });
        expect(mobileUpdateBannerView('checking', idle, undefined)).toMatchObject({
            action: null,
            detail: 'This computer runs a newer Caxri. Update this app to reconnect.',
        });
        expect(
            mobileUpdateBannerView('required', { kind: 'downloading', fraction: 0.5 }, bundle),
        ).toMatchObject({ action: null, detail: 'Downloading 50%' });
    });

    it('retries the question, not the install, when recovery could not reach Desktop', () => {
        expect(mobileUpdateBannerView('unreachable', idle, undefined)).toMatchObject({
            action: 'retry-check',
            actionLabel: 'Retry',
            canDismiss: false,
            detail: "Couldn't reach your computer for the update.",
            isFailure: true,
        });
        expect(
            mobileUpdateBannerView('required', { kind: 'failed', message: 'Try again.' }, bundle),
        ).toMatchObject({ action: 'install', actionLabel: 'Retry', detail: 'Try again.' });
    });
});

describe('preparedMobileUpdateFromRecovery', () => {
    it('hands the recovered download to the install workflow and refuses an empty answer', () => {
        expect(preparedMobileUpdateFromRecovery(prepared)).toEqual(prepared);
        expect(() => preparedMobileUpdateFromRecovery({ bundle: null })).toThrow();
    });
});

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

    it('notifies a later subscriber when an earlier one throws', () => {
        const failing = vi.fn(() => {
            throw new Error('mobile update listener failure');
        });
        const surviving = vi.fn();
        const unsubscribeFailing = mobileUpdateStore.subscribe(failing);
        const unsubscribeSurviving = mobileUpdateStore.subscribe(surviving);

        mobileUpdateStore.setPhase({ kind: 'installing' });

        expect(failing).toHaveBeenCalledTimes(1);
        expect(surviving).toHaveBeenCalledTimes(1);
        unsubscribeFailing();
        unsubscribeSurviving();
    });
});

describe('mobileUpdateNoticeView', () => {
    const idle: MobileUpdatePhase = { kind: 'idle' };

    it('keeps an optional update muted and dismissible', () => {
        expect(mobileUpdateNoticeView('available', idle, bundle)).toMatchObject({
            action: 'install',
            canDismiss: true,
            testID: 'mobile-update-banner',
            tone: 'muted',
        });
    });

    it('warns for a required update, and turns danger when the check failed', () => {
        expect(mobileUpdateNoticeView('required', idle, bundle)).toMatchObject({
            canDismiss: false,
            testID: 'mobile-update-required',
            tone: 'warning',
        });
        expect(mobileUpdateNoticeView('unreachable', idle, undefined)).toMatchObject({
            action: 'retry-check',
            tone: 'danger',
        });
    });

    it('only explains a mismatch that has no build to offer', () => {
        const notice = mobileUpdateNoticeView('mismatch', idle, undefined);
        expect(notice).toMatchObject({
            action: null,
            canDismiss: false,
            testID: 'mobile-version-mismatch',
        });
        expect(notice.message).toContain('Update required');
    });
});

describe('mobileUpdateCheckStatus', () => {
    const idle = {
        canUpdate: true,
        hasAnswer: false,
        isError: false,
        isFetching: false,
        update: undefined,
    };

    it('says the build is current once Desktop answered without a newer one', () => {
        expect(mobileUpdateCheckStatus({ ...idle, hasAnswer: true })).toBe('upToDate');
        expect(mobileUpdateCheckLabel('upToDate')).toBe('Up to date');
    });

    it('stays silent before the first answer and on builds that never ask', () => {
        expect(mobileUpdateCheckStatus(idle)).toBe('idle');
        expect(mobileUpdateCheckStatus({ ...idle, canUpdate: false, hasAnswer: true })).toBe(
            'unsupported',
        );
        expect(mobileUpdateCheckLabel('idle')).toBeUndefined();
        expect(mobileUpdateCheckLabel('unsupported')).toBeUndefined();
    });

    it('shows a manual check in flight over a previous answer, and its failure', () => {
        expect(mobileUpdateCheckStatus({ ...idle, hasAnswer: true, isFetching: true })).toBe(
            'checking',
        );
        expect(mobileUpdateCheckStatus({ ...idle, hasAnswer: true, isError: true })).toBe('failed');
        expect(mobileUpdateCheckLabel('failed')).toBe("Couldn't check");
    });

    it('leaves a newer build to the update row', () => {
        expect(mobileUpdateCheckStatus({ ...idle, isFetching: true, update: bundle })).toBe(
            'available',
        );
        expect(mobileUpdateCheckLabel('available')).toBeUndefined();
    });
});
