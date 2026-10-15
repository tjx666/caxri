import type { MobileUpdateRecoveryPayload } from '@caxri/mobile-transport';
import type { MobileUpdateBundle, MobileUpdatePrepareResult } from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { translate } from '../../i18n';
import { notifyListeners } from '../../lib/notify-listeners';
import type { MobileConnectionStatus } from '../connection/connection-state';

export type MobileUpdatePhase =
    | { kind: 'idle' }
    | { kind: 'downloading'; fraction: number }
    | { kind: 'installing' }
    | { kind: 'failed'; message: string };

/**
 * Offers only a strictly newer build; an unknown installed code never prompts.
 */
export const newerMobileUpdate = (
    installedVersionCode: number | undefined,
    bundle: MobileUpdateBundle | null | undefined,
): MobileUpdateBundle | undefined =>
    bundle && installedVersionCode !== undefined && bundle.versionCode > installedVersionCode
        ? bundle
        : undefined;

/**
 * Update recovery returns the manifest and a download URL in one authenticated answer; the install workflow consumes it
 * in the shape `mobile.update.prepare` returns.
 */
export const preparedMobileUpdateFromRecovery = (
    payload: MobileUpdateRecoveryPayload,
): MobileUpdatePrepareResult => {
    if (payload.bundle === null)
        throw new Error('Caxri on your computer has no update for this app.');
    return { bundle: payload.bundle, expiresAt: payload.expiresAt, url: payload.url };
};

/**
 * `available` offers a newer build while connected. During a version mismatch, `required` offers the build a newer
 * Desktop ships, `checking` waits for its answer, and `unreachable` offers to ask again after the question itself
 * failed; `mismatch` has no build to offer and asks for a manual update.
 */
export type MobileUpdateBannerKind =
    'available' | 'checking' | 'mismatch' | 'required' | 'unreachable';

export const mobileUpdateBannerKind = (input: {
    canRetryCheck: boolean;
    isChecking: boolean;
    isDismissed: boolean;
    isRecovering: boolean;
    phase: MobileUpdatePhase;
    status: MobileConnectionStatus;
    update: MobileUpdateBundle | undefined;
}): MobileUpdateBannerKind | null => {
    if (input.status === 'version-mismatch') {
        if (input.isRecovering && input.update) return 'required';
        if (input.isRecovering && input.isChecking) return 'checking';
        if (input.isRecovering && input.canRetryCheck) return 'unreachable';
        return 'mismatch';
    }
    if (!input.update || (input.isDismissed && input.phase.kind === 'idle')) return null;
    return 'available';
};

export const mobileUpdateSizeLabel = (sizeBytes: number): string =>
    `${Math.max(1, Math.round(sizeBytes / (1_024 * 1_024)))} MB`;

export const mobileUpdateStatusLabel = (
    phase: MobileUpdatePhase,
    t: Translate = translate,
): string | undefined => {
    switch (phase.kind) {
        case 'downloading':
            return t('update.downloading', { percent: Math.floor(phase.fraction * 100) });
        case 'installing':
            return t('update.openingInstaller');
        case 'failed':
            return phase.message;
        case 'idle':
            return undefined;
    }
};

const mobileUpdateBannerDetail = (
    kind: Exclude<MobileUpdateBannerKind, 'mismatch'>,
    phase: MobileUpdatePhase,
    update: MobileUpdateBundle | undefined,
    t: Translate,
): string => {
    const status = mobileUpdateStatusLabel(phase, t);
    if (status) return status;
    if (kind === 'unreachable') return t('update.unreachable');
    if (kind !== 'available' || !update) return t('update.requiredDetail');
    return t('update.availableDetail', {
        size: mobileUpdateSizeLabel(update.sizeBytes),
        version: update.version,
    });
};

export interface MobileUpdateBannerView {
    /**
     * `null` while nothing can be done: recovery is still asking, or an install is downloading or opening.
     */
    action: 'install' | 'retry-check' | null;
    actionLabel: string;
    /**
     * Only an optional update offers "Later"; a required one is the app's only way to reconnect.
     */
    canDismiss: boolean;
    /**
     * The install progress or failure once one started, otherwise why to update.
     */
    detail: string;
    isFailure: boolean;
    isRequired: boolean;
    title: string;
}

export const mobileUpdateBannerView = (
    kind: Exclude<MobileUpdateBannerKind, 'mismatch'>,
    phase: MobileUpdatePhase,
    update: MobileUpdateBundle | undefined,
    t: Translate = translate,
): MobileUpdateBannerView => {
    const isRequired = kind !== 'available';
    const isFailure = phase.kind === 'failed' || kind === 'unreachable';
    const isBusy =
        kind === 'checking' || phase.kind === 'downloading' || phase.kind === 'installing';
    return {
        action: isBusy ? null : kind === 'unreachable' ? 'retry-check' : 'install',
        actionLabel: t(isFailure ? 'common.retry' : 'update.action'),
        canDismiss: !isRequired,
        detail: mobileUpdateBannerDetail(kind, phase, update, t),
        isFailure,
        isRequired,
        title: t(isRequired ? 'update.required' : 'update.available'),
    };
};

export interface MobileUpdateInstallPorts {
    /**
     * Downloads to a private cache file and resolves with its size, MD5, and shareable `content://` URI.
     */
    download: (
        prepared: MobileUpdatePrepareResult,
        onProgress: (fraction: number) => void,
    ) => Promise<{
        contentUri: string;
        discard: () => void;
        md5: string | null;
        sizeBytes: number;
    }>;
    /**
     * Hands the APK to Android's package installer, which verifies the signing certificate against this app.
     */
    launchInstaller: (contentUri: string) => Promise<void>;
    prepare: () => Promise<MobileUpdatePrepareResult>;
}

class MobileUpdateInstallError extends Error {
    override readonly name = 'MobileUpdateInstallError';
}

/**
 * Prepare → download → verify → install. The MD5 comes from the sealed channel, so a truncated or corrupted HTTP body
 * is discarded before the installer ever sees it. A failure message is translated when it happens and stays in that
 * language until the next attempt.
 */
export const installMobileUpdate = async (
    ports: MobileUpdateInstallPorts,
    report: (phase: MobileUpdatePhase) => void,
    t: Translate = translate,
): Promise<void> => {
    try {
        report({ kind: 'downloading', fraction: 0 });
        const prepared = await ports.prepare();
        /**
         * Native progress fires per network chunk; whole percents are all the UI shows, so only those re-render it.
         */
        let lastPercent = 0;
        const file = await ports.download(prepared, (value) => {
            const fraction = Math.min(1, Math.max(0, value));
            const percent = Math.floor(fraction * 100);
            if (percent === lastPercent) return;
            lastPercent = percent;
            report({ kind: 'downloading', fraction });
        });
        if (file.sizeBytes !== prepared.bundle.sizeBytes || file.md5 !== prepared.bundle.md5) {
            file.discard();
            throw new MobileUpdateInstallError(t('update.downloadIncomplete'));
        }
        report({ kind: 'installing' });
        await ports.launchInstaller(file.contentUri);
        report({ kind: 'idle' });
    } catch (error) {
        report({
            kind: 'failed',
            message: error instanceof MobileUpdateInstallError ? error.message : t('update.failed'),
        });
    }
};

type Listener = () => void;

interface MobileUpdateSnapshot {
    /**
     * The Sessions banner stays hidden for this version after "Later" until the app restarts; Settings still offers it.
     */
    dismissedVersionCode?: number;
    phase: MobileUpdatePhase;
}

/**
 * Module-level so the Sessions banner and Settings row observe one download instead of starting two.
 */
class MobileUpdateStore {
    readonly #listeners = new Set<Listener>();
    #snapshot: MobileUpdateSnapshot = { phase: { kind: 'idle' } };

    get = (): MobileUpdateSnapshot => this.#snapshot;

    setPhase = (phase: MobileUpdatePhase): void => {
        this.#update({ ...this.#snapshot, phase });
    };

    dismiss = (versionCode: number): void => {
        this.#update({ ...this.#snapshot, dismissedVersionCode: versionCode });
    };

    subscribe = (listener: Listener): (() => void) => {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    };

    #update(snapshot: MobileUpdateSnapshot): void {
        this.#snapshot = snapshot;
        // Isolates each subscriber so one throwing screen (the Sessions banner or the Settings row) cannot stop the
        // other from observing this update. Mobile has no structured-log sink to report into yet, so the failure is
        // isolated silently rather than reported.
        notifyListeners(this.#listeners, undefined);
    }
}

export const mobileUpdateStore = new MobileUpdateStore();
