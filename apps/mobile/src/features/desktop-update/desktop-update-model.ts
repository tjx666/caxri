import type {
    MobileDesktopUpdateImpact,
    MobileDesktopUpdateResult,
    RemoteUpdateBlockReason,
    UpdateState,
} from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { translate } from '../../i18n';

/**
 * What the phone itself is waiting on after the user acted: `restarting` once the computer accepted the restart (the
 * connection drops next), `blocked` when it refused, with the reason to show.
 */
export type DesktopUpdatePhase =
    | { kind: 'idle' }
    | { kind: 'restarting'; version: string }
    | { kind: 'blocked'; reason: RemoteUpdateBlockReason; unsavedEditorCount?: number };

export type DesktopUpdateAction = 'check' | 'confirm-install' | 'download';

interface DesktopUpdateRowView {
    action: DesktopUpdateAction | null;
    detail?: string;
    isFailure: boolean;
    label: string;
}

export interface DesktopUpdateView {
    /**
     * The `Caxri` row: the computer's version and whether it is current. Tapping it checks again.
     */
    version: { canCheck: boolean; isFailure: boolean; value: string };
    /**
     * The row that moves the update forward, present only when there is a newer version to talk about.
     */
    update?: DesktopUpdateRowView;
}

const isBusyCheck = (state: UpdateState): boolean =>
    state.status === 'checking' || state.status === 'downloading';

/**
 * A development build never checks, so asking it again is pointless and its answer is not a failure.
 */
const isUnpackaged = (state: UpdateState): boolean =>
    state.status === 'unavailable' && state.reason === 'unpackaged';

const versionNote = (state: UpdateState, t: Translate): string | undefined => {
    switch (state.status) {
        case 'checking':
            return t('update.checking');
        case 'up-to-date':
            return t('update.upToDate');
        case 'unavailable':
            if (state.reason === 'unpackaged') return t('desktopUpdate.unpackaged');
            return t(
                state.reason === 'rate-limited'
                    ? 'desktopUpdate.rateLimited'
                    : 'update.checkFailed',
            );
        case 'error':
            return state.action === 'check' ? t('update.checkFailed') : undefined;
        case 'idle':
        case 'available':
        case 'downloading':
        case 'ready':
            return undefined;
    }
};

const desktopUpdateBlockMessage = (
    phase: Extract<DesktopUpdatePhase, { kind: 'blocked' }>,
    t: Translate = translate,
): string => {
    switch (phase.reason) {
        case 'unsaved-editors': {
            const count = phase.unsavedEditorCount ?? 1;
            return t(
                count === 1
                    ? 'desktopUpdate.blocked.unsavedOne'
                    : 'desktopUpdate.blocked.unsavedOther',
                { count },
            );
        }
        case 'resets-data':
            return t('desktopUpdate.resetsData');
        case 'manual-install':
            return t('desktopUpdate.manualInstall');
        case 'desktop-offline':
            return t('desktopUpdate.desktopClosed');
        case 'not-ready':
        case 'version-changed':
        case 'unsupported':
            return t('desktopUpdate.blocked.changed');
    }
};

const updateRow = (
    state: UpdateState,
    phase: DesktopUpdatePhase,
    t: Translate,
): DesktopUpdateRowView | undefined => {
    if (phase.kind === 'restarting')
        return {
            action: null,
            detail: t('desktopUpdate.restartingDetail'),
            isFailure: false,
            label: t('desktopUpdate.restarting', { version: phase.version }),
        };
    switch (state.status) {
        case 'available':
            return {
                action: 'download',
                detail: t('desktopUpdate.availableDetail'),
                isFailure: false,
                label: t('desktopUpdate.updateTo', { version: state.version }),
            };
        case 'downloading': {
            const percent = state.totalBytes
                ? Math.floor((state.receivedBytes / state.totalBytes) * 100)
                : undefined;
            return {
                action: null,
                detail:
                    percent === undefined
                        ? t('desktopUpdate.downloadingDetail')
                        : t('update.downloading', { percent }),
                isFailure: false,
                label: t('desktopUpdate.downloading', { version: state.version }),
            };
        }
        case 'ready': {
            if (state.resetsData)
                return {
                    action: null,
                    detail: t('desktopUpdate.resetsData'),
                    isFailure: false,
                    label: t('desktopUpdate.updateTo', { version: state.version }),
                };
            if (state.installMode === 'manual')
                return {
                    action: null,
                    detail: t('desktopUpdate.manualInstall'),
                    isFailure: false,
                    label: t('desktopUpdate.updateTo', { version: state.version }),
                };
            const blocked =
                phase.kind === 'blocked' ? desktopUpdateBlockMessage(phase, t) : undefined;
            return {
                action: 'confirm-install',
                detail: blocked ?? t('desktopUpdate.readyDetail'),
                isFailure: blocked !== undefined,
                label: t('desktopUpdate.restartTo', { version: state.version }),
            };
        }
        case 'error':
            if (state.action === 'check' || !state.version) return undefined;
            return {
                action: 'download',
                detail: t('desktopUpdate.downloadFailed'),
                isFailure: true,
                label: t('desktopUpdate.retry', { version: state.version }),
            };
        case 'idle':
        case 'checking':
        case 'up-to-date':
        case 'unavailable':
            return undefined;
    }
};

/**
 * The computer's update as the Settings Computer section shows it. `null` hides both rows: an SSH Host window owns no
 * app update, and the phone has no answer yet before its first read.
 */
export const desktopUpdateView = (
    result: MobileDesktopUpdateResult | undefined,
    phase: DesktopUpdatePhase,
    t: Translate = translate,
): DesktopUpdateView | null => {
    if (!result || result.desktop === 'unsupported') return null;
    if (result.desktop === 'offline')
        return {
            version: { canCheck: false, isFailure: false, value: t('desktopUpdate.desktopClosed') },
        };
    const { state } = result;
    const note = versionNote(state, t);
    const update = updateRow(state, phase, t);
    return {
        version: {
            canCheck:
                !isBusyCheck(state) &&
                state.status !== 'ready' &&
                !isUnpackaged(state) &&
                phase.kind !== 'restarting',
            isFailure:
                (state.status === 'unavailable' && !isUnpackaged(state)) ||
                (state.status === 'error' && state.action === 'check'),
            value: [state.currentVersion, note].filter(Boolean).join(' · '),
        },
        ...(update && { update }),
    };
};

/**
 * Whether the phone should keep re-reading: a check or download is still moving on the computer.
 */
export const isDesktopUpdateMoving = (result: MobileDesktopUpdateResult | undefined): boolean =>
    result?.desktop === 'online' && isBusyCheck(result.state);

const countPhrase = (
    count: number,
    one: 'desktopUpdate.impact.terminalsOne' | 'desktopUpdate.impact.chatsOne',
    other: 'desktopUpdate.impact.terminalsOther' | 'desktopUpdate.impact.chatsOther',
    t: Translate,
): string | undefined => (count === 0 ? undefined : t(count === 1 ? one : other, { count }));

/**
 * The confirmation's detail: what the restart stops, the Sessions whose Agent is mid-turn by name, and the unsent
 * review comments it loses. With nothing running it only says the computer will restart.
 */
export const desktopUpdateConfirmDetail = (
    version: string,
    impact: MobileDesktopUpdateImpact | undefined,
    workingSessionTitles: readonly string[],
    t: Translate = translate,
): string => {
    const lines = [t('desktopUpdate.confirm.detail', { version })];
    const running = [
        countPhrase(
            impact?.terminals ?? 0,
            'desktopUpdate.impact.terminalsOne',
            'desktopUpdate.impact.terminalsOther',
            t,
        ),
        countPhrase(
            impact?.chats ?? 0,
            'desktopUpdate.impact.chatsOne',
            'desktopUpdate.impact.chatsOther',
            t,
        ),
    ].filter((phrase): phrase is string => phrase !== undefined);
    if (running.length > 0) {
        const work = running.join(t('desktopUpdate.impact.and'));
        lines.push(t('desktopUpdate.impact.stops', { work }));
    }
    const shown = workingSessionTitles.slice(0, 5);
    if (shown.length > 0) {
        const hidden = workingSessionTitles.length - shown.length;
        const more = hidden > 0 ? t('desktopUpdate.impact.more', { count: hidden }) : undefined;
        const titles = [...shown, more].filter(Boolean).join(t('desktopUpdate.impact.separator'));
        lines.push(t('desktopUpdate.impact.working', { titles }));
    }
    const comments = impact?.pendingReviewComments ?? 0;
    if (comments > 0) {
        const key =
            comments === 1
                ? 'desktopUpdate.impact.reviewCommentsOne'
                : 'desktopUpdate.impact.reviewCommentsOther';
        lines.push(t(key, { count: comments }));
    }
    return lines.join('\n');
};
