import type { ServerEvent } from '@caxri/protocol';

import { translate } from '../i18n';
import { pushToast } from './toasts';

type WorkbenchChangedPayload = Extract<ServerEvent, { event: 'workbench.changed' }>['payload'];

interface WorkbenchRootNotice {
    message: string;
    projectId: string;
    projectTitle: string;
}

/**
 * What a Workbench Root change owes the user, or `undefined` when it owes them nothing.
 *
 * Only a fallback is announced: the worktree the user was working in became unusable, so the Session landing back on
 * its Project is news. A switch the user performed stays silent because they are looking at the picker they used, and
 * so does a switch that follows an Agent into a worktree: the user watched the Agent create or enter it, and the
 * Session row and status bar already show where it landed.
 */
export function workbenchRootNotice(
    payload: WorkbenchChangedPayload,
): WorkbenchRootNotice | undefined {
    if (payload.reason !== 'fallback' || !payload.returnedProjectTitle) return undefined;
    return {
        message: translate('core.workbenchRoot.fallback', { title: payload.returnedProjectTitle }),
        projectId: payload.workbenchRootProjectId,
        projectTitle: payload.returnedProjectTitle,
    };
}

export function reportWorkbenchRootChange(payload: WorkbenchChangedPayload): void {
    const notice = workbenchRootNotice(payload);
    if (!notice) return;
    pushToast('info', notice.message, {
        projectId: notice.projectId,
        projectTitle: notice.projectTitle,
        type: 'worktree-fallback',
    });
}
