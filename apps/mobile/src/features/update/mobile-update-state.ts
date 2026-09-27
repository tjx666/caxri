import type { MobileUpdateBundle, MobileUpdatePrepareResult } from '@caxri/protocol';

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

export const mobileUpdateSizeLabel = (sizeBytes: number): string =>
    `${Math.max(1, Math.round(sizeBytes / (1_024 * 1_024)))} MB`;

export const mobileUpdateStatusLabel = (phase: MobileUpdatePhase): string | undefined => {
    switch (phase.kind) {
        case 'downloading':
            return `Downloading ${Math.floor(phase.fraction * 100)}%`;
        case 'installing':
            return 'Opening installer…';
        case 'failed':
            return phase.message;
        case 'idle':
            return undefined;
    }
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
 * is discarded before the installer ever sees it.
 */
export const installMobileUpdate = async (
    ports: MobileUpdateInstallPorts,
    report: (phase: MobileUpdatePhase) => void,
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
            throw new MobileUpdateInstallError('The download was incomplete. Try again.');
        }
        report({ kind: 'installing' });
        await ports.launchInstaller(file.contentUri);
        report({ kind: 'idle' });
    } catch (error) {
        report({
            kind: 'failed',
            message:
                error instanceof MobileUpdateInstallError
                    ? error.message
                    : 'Update failed. Check that this phone can reach your computer, then try again.',
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
        for (const listener of this.#listeners) listener();
    }
}

export const mobileUpdateStore = new MobileUpdateStore();
