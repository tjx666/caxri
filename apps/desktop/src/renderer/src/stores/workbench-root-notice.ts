import type { ServerEvent } from '@caxri/protocol';

import { translate } from '../i18n';
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
    previousWorkbenchRootProjectId: string | undefined,
): WorkbenchRootNotice | undefined {
    if (payload.reason === 'fallback')
        return payload.returnedProjectTitle
            ? {
                  kind: 'fallback',
                  message: translate('core.workbenchRoot.fallback', {
                      title: payload.returnedProjectTitle,
                  }),
                  projectId: payload.workbenchRootProjectId,
                  projectTitle: payload.returnedProjectTitle,
              }
            : undefined;
    if (payload.reason !== 'followed') return undefined;
    return {
        kind: 'followed',
        message: payload.followedProjectTitle
            ? translate('core.workbenchRoot.followedNamed', { title: payload.followedProjectTitle })
            : translate('core.workbenchRoot.followed'),
        projectId: payload.workbenchRootProjectId,
        ...(payload.followedProjectTitle && { projectTitle: payload.followedProjectTitle }),
        // Undo is offered only when a different, still-known root can actually be restored.
        ...(previousWorkbenchRootProjectId &&
            previousWorkbenchRootProjectId !== payload.workbenchRootProjectId && {
                undoProjectId: previousWorkbenchRootProjectId,
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
    return tryCommand(translate('core.workbenchRoot.undoFailed'), () =>
        caxri.request('session.selectWorkbenchRoot', { sessionId, projectId }),
    );
}

/**
 * `previousWorkbenchRootProjectId` must be captured before the change is applied; it cannot be re-derived afterwards.
 */
export function reportWorkbenchRootChange(
    payload: WorkbenchChangedPayload,
    previousWorkbenchRootProjectId: string | undefined,
): void {
    const notice = workbenchRootNotice(payload, previousWorkbenchRootProjectId);
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
                    followedProjectId: payload.workbenchRootProjectId,
                },
                accessibleLabel: notice.projectTitle
                    ? translate('core.workbenchRoot.undoNamed', { title: notice.projectTitle })
                    : translate('core.workbenchRoot.undo'),
            },
        }),
    });
}
