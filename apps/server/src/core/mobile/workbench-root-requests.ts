import type { MobileWorkbenchRoot, Principal, ServerRequest } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { ServerDomainService } from '../domain-service';
import { sessionForPrincipal } from './session-management';

type WorkbenchRootList = Extract<ServerRequest, { method: 'mobile.workbenchRoot.list' }>;
type WorkbenchRootSelect = Extract<ServerRequest, { method: 'mobile.workbenchRoot.select' }>;

/**
 * Lists the Session's worktrees from the same `session.workbenchRoots` Desktop's status bar picker reads, after
 * admitting the Session for this device. Folder paths stay on the computer.
 */
export async function listMobileWorkbenchRoots(
    domainService: ServerDomainService,
    principal: Principal,
    request: WorkbenchRootList,
): Promise<{ roots: MobileWorkbenchRoot[] }> {
    const { sessionId } = request.params;
    const session = await sessionForPrincipal(domainService, principal, sessionId);
    // react-doctor-disable-next-line react-doctor/server-sequential-independent-await -- the device must be admitted before Desktop's worktree topology is read.
    const roots = await domainService.request('session.workbenchRoots', { sessionId });
    return {
        roots: roots.map((root) => ({
            ...(root.projectId !== undefined && { projectId: root.projectId }),
            title: root.title,
            branch: root.branch,
            isMain: root.isMain,
            isCurrent:
                root.projectId !== undefined && root.projectId === session.workbenchRootProjectId,
        })),
    };
}

/**
 * Switches through Desktop's own `session.selectWorkbenchRoot`. The target must be one of this Session's authorized
 * worktrees as listed right now, so a phone can neither name an unrelated Project nor authorize a new folder.
 */
export async function selectMobileWorkbenchRoot(
    domainService: ServerDomainService,
    principal: Principal,
    request: WorkbenchRootSelect,
): Promise<null> {
    const { projectId, sessionId } = request.params;
    await sessionForPrincipal(domainService, principal, sessionId);
    const roots = await domainService.request('session.workbenchRoots', { sessionId });
    if (roots.every((root) => root.projectId !== projectId))
        throw new CaxriError('NOT_FOUND', 'Worktree not found');
    await domainService.request('session.selectWorkbenchRoot', { sessionId, projectId });
    return null;
}
