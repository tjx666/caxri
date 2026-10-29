import type { BootstrapState, ServerEvent } from '@caxri/protocol';

import type { AgentDelegationService } from './agent-delegation';
import type { CaxriDatabase } from './db';
import type { DomainHandlers } from './domain-services';
import type { MobileTerminalMutationQueue } from './mobile';

interface DeletionHandlerOptions {
    database: CaxriDatabase;
    delegations: AgentDelegationService;
    mobileTerminalMutations: MobileTerminalMutationQueue;
    bootstrapState(windowKey?: string): BootstrapState;
    forgetSessionRuntime(sessionId: string): void;
    evictSessions(sessionIds: readonly string[]): void;
    projectDeleted(workbenchSessionIds: string[]): void;
    /**
     * Runs after the Project's metadata is gone; failures are the callee's to log.
     */
    projectMetadataDeleted?(): void;
    restoreSelection(): void;
    send(event: ServerEvent): void;
}

/**
 * Reclaims private delegation files before the owning metadata disappears, then retires runtime and selection state.
 * Authorized Project folders and user files are never deletion targets.
 */
export function createDeletionHandlers(
    options: DeletionHandlerOptions,
): Pick<DomainHandlers, 'session.delete' | 'session.deleteMany' | 'project.delete'> {
    const { database } = options;
    const finish = (reason: 'session.delete' | 'project.delete', windowKey?: string) => {
        options.restoreSelection();
        options.send({ event: 'state.changed', payload: { kind: 'full', reason } });
        return options.bootstrapState(windowKey);
    };
    const deleteSessions = (sessionIds: readonly string[], windowKey?: string) =>
        options.delegations.deleteSessions(sessionIds, () =>
            options.mobileTerminalMutations.runSessions(sessionIds, () => {
                for (const id of sessionIds) options.forgetSessionRuntime(id);
                options.evictSessions(sessionIds);
                for (const id of sessionIds) database.deleteSession(id);
                return finish('session.delete', windowKey);
            }),
        );
    return {
        'session.delete': ({ sessionId, windowKey }) => deleteSessions([sessionId], windowKey),
        'session.deleteMany': ({ sessionIds, windowKey }) =>
            deleteSessions([...new Set(sessionIds)], windowKey),
        'project.delete': ({ projectId, windowKey }) =>
            options.mobileTerminalMutations.runProject(projectId, () => {
                const { owned, workbench } = database.projectDeletionScope(projectId);
                const affected = [
                    ...new Set([...owned, ...workbench].map((session) => session.id)),
                ];
                return options.delegations.deleteSessions(
                    owned.map((session) => session.id),
                    () =>
                        options.mobileTerminalMutations.runSessions(affected, () => {
                            for (const session of owned) options.forgetSessionRuntime(session.id);
                            options.evictSessions(affected);
                            database.deleteProject(projectId);
                            options.projectDeleted(workbench.map((session) => session.id));
                            options.projectMetadataDeleted?.();
                            return finish('project.delete', windowKey);
                        }),
                );
            }),
    };
}
