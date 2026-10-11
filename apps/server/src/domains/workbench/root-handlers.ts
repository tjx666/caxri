import type { DomainHandlers } from '../domain-services';
import type { WorkbenchRootService } from './roots';

type WorkbenchRootHandlers = Pick<
    DomainHandlers,
    | 'session.authorizeWorkbenchRoot'
    | 'session.continueInWorktree'
    | 'session.dismissWorkbenchCandidate'
    | 'session.selectWorkbenchRoot'
    | 'session.validateWorkbenchRoots'
    | 'session.workbenchCandidate.authorize'
    | 'session.workbenchCandidate.cancel'
    | 'session.workbenchCandidate.claim'
    | 'session.workbenchRoot.authorizeSelection'
    | 'session.workbenchRoot.resolve'
    | 'session.workbenchRoot.forgetEditorPath'
    | 'session.workbenchRoots'
>;

/**
 * Keeps the Workbench Root protocol surface beside its state machine rather than in bootstrap. It sits in its own
 * module because `roots.ts` holds the whole state machine and is already at the 800-line ceiling; the
 * request-to-service mapping is the part that can leave without splitting that machine.
 */
export function createWorkbenchRootHandlers(
    service: WorkbenchRootService,
    mainOwned: (method: 'session.authorizeWorkbenchRoot' | 'session.continueInWorktree') => never,
): WorkbenchRootHandlers {
    return {
        'session.authorizeWorkbenchRoot': () => mainOwned('session.authorizeWorkbenchRoot'),
        'session.workbenchRoot.resolve': ({ sessionId, worktreeId }) =>
            service.resolveWorktree(sessionId, worktreeId),
        'session.continueInWorktree': () => mainOwned('session.continueInWorktree'),
        'session.workbenchRoots': ({ sessionId }) => service.listOptions(sessionId),
        'session.selectWorkbenchRoot': ({ sessionId, projectId }) =>
            service.select(sessionId, projectId),
        'session.workbenchRoot.forgetEditorPath': ({ sessionId, workbenchProjectId, path }) => {
            service.forgetEditorPath(sessionId, workbenchProjectId, path);
            return null;
        },
        'session.dismissWorkbenchCandidate': ({ sessionId, candidateId }) => {
            service.dismissCandidate(sessionId, candidateId);
            return null;
        },
        'session.workbenchCandidate.claim': ({ sessionId, candidateId }) =>
            service.claimCandidate(sessionId, candidateId),
        'session.workbenchCandidate.authorize': ({ sessionId, candidateId, rootPath }) =>
            service.authorizeCandidate(sessionId, candidateId, rootPath),
        'session.workbenchCandidate.cancel': ({ sessionId, candidateId }) => {
            service.cancelCandidate(sessionId, candidateId);
            return null;
        },
        'session.workbenchRoot.authorizeSelection': ({ sessionId, rootPath, worktreeId }) =>
            service.authorizeSelection(sessionId, rootPath, worktreeId),
        'session.validateWorkbenchRoots': async ({ sessionId }) => {
            await service.validate(sessionId);
            return null;
        },
    };
}
