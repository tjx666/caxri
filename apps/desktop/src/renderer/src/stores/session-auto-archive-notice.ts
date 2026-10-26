import type { BootstrapState, ServerEvent } from '@caxri/protocol';

import { describeAutoArchivedSession } from '../features/session/session-notice-copy';
import { sessionTitleForDisplay } from '../features/session/session-title';
import { translate } from '../i18n';
import type { ToastAction } from './toast-actions';
import { pushToast } from './toasts';

type SessionAutoArchivedPayload = Extract<
    ServerEvent,
    { event: 'session.autoArchived' }
>['payload'];

/**
 * What the user sees when Server Core archives a Session on their behalf: the sentence and the Undo that restores the
 * row where it was. Pure so the mapping is testable without the toast store.
 */
export function describeSessionAutoArchive(
    payload: SessionAutoArchivedPayload,
    bootstrap: BootstrapState | undefined,
): { action: ToastAction; message: string } {
    const displayTitle = bootstrap?.sessions.find(
        (session) => session.id === payload.sessionId,
    )?.displayTitle;
    return {
        message: describeAutoArchivedSession(displayTitle, payload.pullRequestState),
        action: {
            id: 'session.unarchive',
            params: { sessionId: payload.sessionId },
            accessibleLabel: translate('session.notice.undoArchive', {
                title: sessionTitleForDisplay(displayTitle ?? '', translate),
            }),
        },
    };
}

/**
 * Tells the user a Session disappeared from the PrimarySidebar because its pull request was merged or closed. Undo
 * restores with `unchanged` placement, the same as undoing a manual archive.
 */
export function reportSessionAutoArchived(
    payload: SessionAutoArchivedPayload,
    bootstrap: BootstrapState | undefined,
): void {
    const { action, message } = describeSessionAutoArchive(payload, bootstrap);
    pushToast('info', message, { action });
}
