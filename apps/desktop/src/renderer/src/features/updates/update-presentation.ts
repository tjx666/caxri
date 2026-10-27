import type { UpdateState } from '@caxri/protocol';
import { isUpdateVersionSkipped } from '@caxri/protocol';
import { formatBytes } from '@caxri/utils';

import type { Translate } from '../../i18n';
import { translate } from '../../i18n';
import { formatTime } from '../../lib/locale-format';

/**
 * Everything the update surfaces decide from `UpdateState` plus the user's persisted skip, kept pure so the rules that
 * matter (when Caxri may interrupt, what the status bar carries, and what a rate-limited check is allowed to claim) are
 * covered by tests instead of by reading a `.tsx`.
 */

/**
 * The clock time a recovery sentence can name, or `undefined` for a deadline that has already passed, so a sentence is
 * never composed promising a retry in the past.
 *
 * The locale follows the interface language rather than the host, so the time reads in the same language as the
 * sentence around it; the time zone is left to the host, which is the machine the user is reading the window on. This
 * mirrors the Server's `retryTimeLabel` (`apps/server/src/domains/retry-time.ts`) for the Project Status budget rows:
 * the two cannot share a module today because one runs in the Server process and the other in the Renderer, and neither
 * package owns a shared formatting layer yet.
 */
export function updateRetryTimeLabel(
    retryAt: number | undefined,
    now: number = Date.now(),
): string | undefined {
    if (retryAt === undefined || !Number.isFinite(retryAt) || retryAt <= now) return undefined;
    return formatTime(retryAt);
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
 *
 * `t` defaults to the out-of-React `translate` so tests and non-render callers need not pass one; a component passes
 * its `useTranslation()` `t` so a language change re-renders the copy.
 */
export function describeUpdateStatus(
    state: UpdateState | undefined,
    options: { now?: number; skippedVersion?: string | null; t?: Translate } = {},
): UpdateStatusCopy {
    const t = options.t ?? translate;
    if (!state)
        return {
            title: t('updates.status.loading.title'),
            description: t('updates.status.loading.description'),
        };
    switch (state.status) {
        case 'idle':
            return {
                title: t('updates.status.version', { version: state.currentVersion }),
                description: t('updates.status.idle.description'),
            };
        case 'checking':
            return {
                title: t('updates.status.checking.title'),
                description: t('updates.status.version', { version: state.currentVersion }),
            };
        case 'unavailable': {
            if (!state.rateLimited)
                return { title: t('updates.status.unavailable.title'), description: state.reason };
            const resumesAt = updateRetryTimeLabel(state.retryAt, options.now);
            return {
                title: t('updates.status.paused.title'),
                description: t('updates.status.paused.description', {
                    reason: state.reason,
                    resume: resumesAt
                        ? t('updates.status.paused.resumesAt', { time: resumesAt })
                        : t('updates.status.paused.resumesLater'),
                }),
            };
        }
        case 'up-to-date':
            return {
                title: t('updates.status.upToDate.title'),
                description: t('updates.status.upToDate.description', {
                    version: state.currentVersion,
                }),
            };
        case 'available':
            return {
                title: t('updates.status.available.title', { version: state.version }),
                description: isUpdateVersionSkipped(state.version, options.skippedVersion)
                    ? t('updates.status.available.skippedDescription', {
                          fileName: state.fileName,
                      })
                    : t('updates.status.available.description', { fileName: state.fileName }),
            };
        case 'downloading':
            return {
                title: t('updates.status.downloading.title', { version: state.version }),
                description: state.totalBytes
                    ? t('updates.status.downloading.progress', {
                          received: formatBytes(state.receivedBytes),
                          total: formatBytes(state.totalBytes),
                      })
                    : t('updates.status.downloading.received', {
                          received: formatBytes(state.receivedBytes),
                      }),
            };
        case 'ready':
            return {
                title: t('updates.status.ready.title', { version: state.version }),
                description: t(
                    state.installMode === 'restart'
                        ? 'updates.status.ready.restartDescription'
                        : 'updates.status.ready.description',
                ),
            };
        case 'error':
            return {
                title: t('updates.status.error.title'),
                description: t(
                    state.action === 'install'
                        ? 'updates.status.error.install'
                        : state.failureKind === 'network'
                          ? 'updates.status.error.network'
                          : state.failureKind === 'integrity'
                            ? 'updates.status.error.integrity'
                            : state.action === 'open'
                              ? 'updates.status.error.open'
                              : 'updates.status.error.generic',
                ),
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
    t: Translate = translate,
): UpdateChip | undefined {
    if (!state) return undefined;
    if (state.status === 'available') {
        if (isUpdateVersionSkipped(state.version, skippedVersion)) return undefined;
        return {
            label: t('updates.chip.available.label', { version: state.version }),
            description: t('updates.chip.available.description', { version: state.version }),
            kind: 'available',
        };
    }
    if (state.status === 'downloading') {
        const percent =
            state.totalBytes === undefined
                ? undefined
                : Math.min(100, Math.floor((state.receivedBytes / state.totalBytes) * 100));
        return {
            label:
                percent === undefined
                    ? t('updates.chip.downloading.label')
                    : t('updates.chip.downloading.labelPercent', { percent }),
            description: t('updates.chip.downloading.description', { version: state.version }),
            kind: 'downloading',
        };
    }
    if (state.status === 'ready') {
        const isRestart = state.installMode === 'restart';
        return {
            label: t(isRestart ? 'updates.chip.ready.restartLabel' : 'updates.chip.ready.label'),
            description: t(
                isRestart
                    ? 'updates.chip.ready.restartDescription'
                    : 'updates.chip.ready.description',
                { version: state.version },
            ),
            kind: 'ready',
        };
    }
    if (state.status === 'error' && state.action !== 'check' && state.version)
        return {
            label: t('updates.chip.failed.label'),
            description: t(
                state.action === 'open' || state.action === 'install'
                    ? 'updates.chip.failed.installDescription'
                    : 'updates.chip.failed.downloadDescription',
                { version: state.version },
            ),
            kind: 'failed',
        };
    return undefined;
}

/**
 * The release automatic discovery may start downloading on its own, or `undefined`.
 *
 * Caxri is a tool people open while already doing something else, so a release found on its own is fetched quietly in
 * the background and the user hears about it once, when it is ready to install (`resolveReadyAnnouncement`); the modal
 * dialog is reserved for a user who explicitly asked. Three conditions have to hold, and each maps to a way this
 * feature used to nag:
 *
 * - The state is `available`. A download cancelled back to `available` is republished, which is why the check below is
 *   not "did the status change".
 * - This process has not offered the version yet (`announced`). That is what keeps a cancelled download cancelled and a
 *   window reload from starting a second one.
 * - The version is not covered by `updates.skippedVersion`, which outlives the process on purpose.
 */
export function resolveAutomaticDownload(
    state: UpdateState | undefined,
    skippedVersion?: string | null,
): string | undefined {
    if (state?.status !== 'available') return undefined;
    if (state.announced === true) return undefined;
    if (isUpdateVersionSkipped(state.version, skippedVersion)) return undefined;
    return state.version;
}

/**
 * The notification for a verified update, raised once per version and process (`announced`). A restart-ready update
 * offers `Restart to Update` directly; a manual one opens the dialog, whose DMG instructions do not fit a notification.
 * The skip is not consulted: a `ready` update is one the user or the automatic download already chose to fetch, and the
 * dialog's own skip covers only `available`.
 */
export function resolveReadyAnnouncement(
    state: UpdateState | undefined,
): { message: string; mode: 'manual' | 'restart'; version: string } | undefined {
    if (state?.status !== 'ready' || state.announced === true) return undefined;
    return {
        version: state.version,
        mode: state.installMode,
        message: translate(
            state.installMode === 'restart'
                ? 'updates.ready.message'
                : 'updates.ready.manualMessage',
            { version: state.version },
        ),
    };
}

/**
 * Whether the unsigned-install notice belongs on screen. It explains what the user has to do with a downloaded DMG, so
 * it appears only once replacing the app by hand is actually the next step: a verified update that cannot restart into
 * itself (`installMode: 'manual'`), or a failure with a release in play, where the DMG is the fallback. While the
 * update is still downloading Caxri does not know yet, and most installs never need the notice: `Restart to Update`
 * replaces the app without any macOS prompt.
 */
export function shouldExplainUnsignedInstall(state: UpdateState | undefined): boolean {
    if (!state) return false;
    if (state.status === 'error') return Boolean(state.version) && state.action !== 'check';
    return state.status === 'ready' && state.installMode === 'manual';
}

const RELEASES_URL = 'https://github.com/tjx666/caxri/releases';

/**
 * Where "Release Notes" opens: the release page Main read from GitHub when it has one, otherwise the tag page for the
 * version, which GitHub serves for any published release.
 */
export function releaseNotesUrl(version: string, releaseUrl?: string): string {
    return releaseUrl ?? `${RELEASES_URL}/tag/v${version}`;
}

/**
 * The release a state is about, for the dialog's "View Release Notes" button; `undefined` for states with no version in
 * play (checking, up to date, a failed check).
 */
export function releaseNotesTarget(
    state: UpdateState | undefined,
): { url: string; version: string } | undefined {
    if (!state) return undefined;
    if (state.status === 'error') {
        return state.version
            ? { url: releaseNotesUrl(state.version), version: state.version }
            : undefined;
    }
    switch (state.status) {
        case 'available':
        case 'downloading':
        case 'ready': {
            return {
                url: releaseNotesUrl(state.version, state.releaseUrl),
                version: state.version,
            };
        }
        default: {
            return undefined;
        }
    }
}

/**
 * The one-time "Updated to Caxri X" notice: present while Main reports that this launch replaced an older version
 * (`updatedFrom`), and `undefined` otherwise, including on a first install where there is nothing to compare with.
 */
export function resolveUpdatedNotice(
    state: UpdateState | undefined,
): { message: string; version: string } | undefined {
    if (!state?.updatedFrom) return undefined;
    return {
        version: state.currentVersion,
        message: translate('updates.updated.message', { version: state.currentVersion }),
    };
}
