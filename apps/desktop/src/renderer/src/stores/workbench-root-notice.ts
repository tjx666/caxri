import type { ServerEvent } from '@caxri/protocol';

import { caxri } from '../lib/caxri';
import { pushToast, tryCommand } from './toasts';

type WorkbenchChangedPayload = Extract<ServerEvent, { event: 'workbench.changed' }>['payload'];

/**
 * What a Workbench Root change owes the user, or `undefined` when it owes them nothing.
 *
 * A `followed` notice carries the root to return to, because the incoming snapshot has already replaced it by the time
 * the user reaches for an undo.
 */
export type WorkbenchRootNotice = { message: string; projectId: string; projectTitle?: string } & (
    { kind: 'fallback' } | { kind: 'followed'; undoProjectId?: string }
);

/**
 * A switch the user just performed themselves stays silent: they are looking at the picker they used. The two changes
 * nobody asked for do not, because re-rooting a Session re-roots the Files tree, Source Control, Project Status and the
 * Editor at once, while the only other cue is the folder name in the status bar.
 */
export function workbenchRootNotice(
    payload: WorkbenchChangedPayload,
    previousWorkbenchProjectId: string | undefined,
): WorkbenchRootNotice | undefined {
    if (payload.reason === 'fallback')
        return payload.returnedProjectTitle
            ? {
                  kind: 'fallback',
                  message: `The active worktree is no longer available. Returned to ${payload.returnedProjectTitle}.`,
                  projectId: payload.workbenchProjectId,
                  projectTitle: payload.returnedProjectTitle,
              }
            : undefined;
    if (payload.reason !== 'followed') return undefined;
    return {
        kind: 'followed',
        message: payload.followedProjectTitle
            ? `Switched to worktree "${payload.followedProjectTitle}": an Agent moved there.`
            : 'Switched to another worktree: an Agent moved there.',
        projectId: payload.workbenchProjectId,
        ...(payload.followedProjectTitle && { projectTitle: payload.followedProjectTitle }),
        // Undo is offered only when a different, still-known root can actually be restored.
        ...(previousWorkbenchProjectId &&
            previousWorkbenchProjectId !== payload.workbenchProjectId && {
                undoProjectId: previousWorkbenchProjectId,
            }),
    };
}

/**
 * Returns the Session to the Workbench Root it held before an Agent moved it. Server revalidates the target exactly as
 * it does for the picker's own switch, so a root that was deleted, replaced, or is no longer a linked worktree of this
 * Session's Project rejects the request; `tryCommand` reports that as one error toast instead of an unhandled
 * rejection. The successful switch converges the Workbench through the `state.changed` Server publishes with it.
 */
export function undoFollowedWorkbenchRoot(sessionId: string, projectId: string): Promise<unknown> {
    return tryCommand('Unable to return to the previous Workbench Root', () =>
        caxri.request('session.selectWorkbenchRoot', { sessionId, projectId }),
    );
}

/**
 * `previousWorkbenchProjectId` must be captured before the change is applied; it cannot be re-derived afterwards.
 */
export function reportWorkbenchRootChange(
    payload: WorkbenchChangedPayload,
    previousWorkbenchProjectId: string | undefined,
): void {
    const notice = workbenchRootNotice(payload, previousWorkbenchProjectId);
    if (!notice) return;
    const undoProjectId = notice.kind === 'followed' ? notice.undoProjectId : undefined;
    pushToast('info', notice.message, {
        projectId: notice.projectId,
        projectTitle: notice.projectTitle,
        ...(notice.kind === 'fallback' && { type: 'worktree-fallback' }),
        ...(undoProjectId && {
            action: {
                id: 'workbench.undoFollowedRoot',
                params: {
                    sessionId: payload.sessionId,
                    projectId: undoProjectId,
                    followedProjectId: payload.workbenchProjectId,
                },
                accessibleLabel: notice.projectTitle
                    ? `Undo the switch to worktree ${notice.projectTitle}`
                    : 'Undo the switch to another worktree',
            },
        }),
    });
}
