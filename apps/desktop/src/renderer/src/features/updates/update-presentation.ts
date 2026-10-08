import type { UpdateState } from '@caxri/protocol';
import { isUpdateVersionSkipped } from '@caxri/protocol';
import { formatBytes } from '@caxri/utils';

/**
 * Everything the update surfaces decide from `UpdateState` plus the user's persisted skip, kept pure so the rules that
 * matter (when Caxri may interrupt, what the status bar carries, and what a rate-limited check is allowed to claim) are
 * covered by tests instead of by reading a `.tsx`.
 */

/**
 * The clock time a recovery sentence can name, or `undefined` for a deadline that has already passed, so a sentence is
 * never composed promising a retry in the past.
 *
 * The locale is pinned rather than read from the host because every Caxri UI string is English; the time zone is left
 * to the host, which is the machine the user is reading the window on. This mirrors the Server's `retryTimeLabel`
 * (`apps/server/src/domains/retry-time.ts`) for the Project Status budget rows: the two cannot share a module today
 * because one runs in the Server process and the other in the Renderer, and neither package owns a shared formatting
 * layer yet.
 */
export function updateRetryTimeLabel(
    retryAt: number | undefined,
    now: number = Date.now(),
): string | undefined {
    if (retryAt === undefined || !Number.isFinite(retryAt) || retryAt <= now) return undefined;
    return new Date(retryAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export interface UpdateStatusCopy {
    title: string;
    description: string;
}

/**
 * Title and supporting sentence for the update dialog.
 *
 * The rate-limited `unavailable` case is the one that earns its own branch: a plain "unavailable" with a disabled
 * button tells the user neither how long the pause lasts nor that the button they cannot press is exactly the one that
 * would get past it. A manual check bypasses the recorded window, so the copy says so and the action stays live:
 * deliberately unlike the Project Status budget rows, where retrying is the very request the limiter is refusing.
 */
export function describeUpdateStatus(
    state: UpdateState | undefined,
    options: { now?: number; skippedVersion?: string | null } = {},
): UpdateStatusCopy {
    if (!state) return { title: 'Loading update status…', description: 'Please wait.' };
    switch (state.status) {
        case 'idle':
            return {
                title: `Caxri ${state.currentVersion}`,
                description: 'Check GitHub Releases for a newer stable version.',
            };
        case 'checking':
            return { title: 'Checking for updates…', description: `Caxri ${state.currentVersion}` };
        case 'unavailable': {
            if (!state.rateLimited)
                return { title: 'Update checks unavailable', description: state.reason };
            const resumesAt = updateRetryTimeLabel(state.retryAt, options.now);
            return {
                title: 'Update checks are paused',
                description: `${state.reason} ${
                    resumesAt
                        ? `Automatic checks resume after ${resumesAt}.`
                        : 'Automatic checks resume once the limit clears.'
                } Checking now asks GitHub anyway, without waiting.`,
            };
        }
        case 'up-to-date':
            return {
                title: 'Caxri is up to date',
                description: `You are running the latest version, ${state.currentVersion}.`,
            };
        case 'available':
            return {
                title: `Caxri ${state.version} is available`,
                description: isUpdateVersionSkipped(state.version, options.skippedVersion)
                    ? `You skipped this version, so Caxri stopped offering it. Stop skipping to download ${state.fileName} and verify it here.`
                    : `Download ${state.fileName} inside Caxri and verify it before opening.`,
            };
        case 'downloading':
            return {
                title: `Downloading Caxri ${state.version}…`,
                description: state.totalBytes
                    ? `${formatBytes(state.receivedBytes)} of ${formatBytes(state.totalBytes)}`
                    : `${formatBytes(state.receivedBytes)} downloaded`,
            };
        case 'ready':
            return {
                title: `Caxri ${state.version} is ready to install`,
                description: 'The DMG passed SHA-256 verification.',
            };
        case 'error':
            return {
                title: 'Update failed',
                description:
                    state.failureKind === 'network'
                        ? 'The update connection was interrupted. Check your network and try again.'
                        : state.failureKind === 'integrity'
                          ? 'The download could not be verified and was not opened. Download it again.'
                          : state.action === 'open'
                            ? 'The downloaded installer could not be opened. Try again or open it from Finder.'
                            : 'The update could not be completed. Please try again.',
            };
    }
}

/**
 * `true` while the dialog's primary action can still reach GitHub. Only the two causes a retry cannot fix (an
 * unpackaged build, and a release feed that is not published yet) disable it; a rate limit does not, because a manual
 * check bypasses the recorded window.
 */
export function canRetryUpdateCheck(state: UpdateState | undefined): boolean {
    return state?.status !== 'unavailable' || state.rateLimited === true;
}

export interface UpdateChip {
    /**
     * Short status-bar text. Long prose belongs in `description`, which is both the tooltip and the accessible name.
     */
    label: string;
    description: string;
    kind: 'available' | 'downloading' | 'failed' | 'ready';
}

/**
 * The status-bar chip for the durable halves of the update lifecycle.
 *
 * Downloading and ready-to-install outlive any dialog the user closed, so they need a home that is not a dialog; and an
 * available release the user merely closed still has to be reachable without waiting for the next launch. The chip is
 * deliberately quiet (`--muted`, like Screencast Mode): DESIGN.md reserves a coloured status-bar chip for a degraded
 * Caxri, and an available update is not a degradation.
 *
 * A skipped version drops the `available` chip but never the download or install chips: those describe work the user
 * started themselves, and hiding them would strand a half-finished download with no way back to it.
 *
 * A failed download or install keeps a chip for the same reason. The dialog invites the user to close it and keep
 * working, so by the time the download breaks the chip is the only surface left; without one the progress text simply
 * disappears and the release becomes unreachable until the next automatic check. A failed background _check_ is
 * deliberately excluded: nobody asked for it, and an offline machine would otherwise wear a permanent chip.
 */
export function describeUpdateChip(
    state: UpdateState | undefined,
    skippedVersion?: string | null,
): UpdateChip | undefined {
    if (!state) return undefined;
    if (state.status === 'available') {
        if (isUpdateVersionSkipped(state.version, skippedVersion)) return undefined;
        return {
            label: `Update ${state.version}`,
            description: `Caxri ${state.version} is available. Click to show the update.`,
            kind: 'available',
        };
    }
    if (state.status === 'downloading') {
        const percent =
            state.totalBytes === undefined
                ? undefined
                : Math.min(100, Math.floor((state.receivedBytes / state.totalBytes) * 100));
        return {
            label: percent === undefined ? 'Updating…' : `Updating ${percent}%`,
            description: `Downloading Caxri ${state.version}. Click to show the download.`,
            kind: 'downloading',
        };
    }
    if (state.status === 'ready')
        return {
            label: 'Update ready',
            description: `Caxri ${state.version} is downloaded and verified. Click to install it.`,
            kind: 'ready',
        };
    if (state.status === 'error' && state.action !== 'check' && state.version)
        return {
            label: 'Update failed',
            description: `Caxri ${state.version} could not be ${
                state.action === 'open' ? 'installed' : 'downloaded'
            }. Click to see why and try again.`,
            kind: 'failed',
        };
    return undefined;
}

export interface UpdateAnnouncement {
    version: string;
    message: string;
}

/**
 * Whether automatic discovery may interrupt, and with what.
 *
 * Caxri is a tool people open while already doing something else, so a release found on its own raises a notification
 * and nothing more; the modal dialog is reserved for a user who explicitly asked. Three conditions have to hold, and
 * each maps to a way this feature used to nag:
 *
 * - The state is `available`. A download cancelled back to `available` is republished, which is why the check below is
 *   not "did the status change".
 * - This process has not offered the version yet (`announced`). That is what makes a window reload, and that same
 *   cancelled download, silent, and what keeps `Close` meaning "not now" rather than "never".
 * - The version is not covered by `updates.skippedVersion`, which outlives the process on purpose.
 */
export function resolveUpdateAnnouncement(
    state: UpdateState | undefined,
    skippedVersion?: string | null,
): UpdateAnnouncement | undefined {
    if (state?.status !== 'available') return undefined;
    if (state.announced === true) return undefined;
    if (isUpdateVersionSkipped(state.version, skippedVersion)) return undefined;
    return {
        version: state.version,
        message: `Caxri ${state.version} is available. You are running ${state.currentVersion}.`,
    };
}

/**
 * Whether the unsigned-install notice belongs on screen. It explains what the user has to do with a downloaded DMG, so
 * it appears exactly while a specific release is in play (including a failed download, where the file may still be on
 * disk) and never while Caxri is merely checking or already current.
 */
export function shouldExplainUnsignedInstall(state: UpdateState | undefined): boolean {
    if (!state) return false;
    if (state.status === 'error') return Boolean(state.version);
    return ['available', 'downloading', 'ready'].includes(state.status);
}
