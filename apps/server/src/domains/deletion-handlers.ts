import type { BootstrapState, ServerEvent } from '@caxri/protocol';

import type { AgentDelegationService } from './agent-delegation';
import type { CaxriDatabase } from './db';
import type { DomainHandlers } from './domain-services';
import type { MobileTerminalMutationQueue } from './mobile-terminal-mutation-queue';

interface DeletionHandlerOptions {
    database: CaxriDatabase;
    delegations: AgentDelegationService;
    mobileTerminalMutations: MobileTerminalMutationQueue;
    bootstrapState(): BootstrapState;
    forgetSessionRuntime(sessionId: string): void;
    evictSessions(sessionIds: readonly string[]): void;
    projectDeleted(workbenchSessionIds: string[]): void;
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
    const finish = (reason: 'session.delete' | 'project.delete') => {
        options.restoreSelection();
        options.send({ event: 'state.changed', payload: { kind: 'full', reason } });
        return options.bootstrapState();
    };
    const deleteSessions = (sessionIds: readonly string[]) =>
        options.delegations.deleteSessions(sessionIds, () =>
            options.mobileTerminalMutations.runSessions(sessionIds, () => {
                for (const id of sessionIds) options.forgetSessionRuntime(id);
                options.evictSessions(sessionIds);
                for (const id of sessionIds) database.deleteSession(id);
                return finish('session.delete');
            }),
        );
    return {
        'session.delete': ({ sessionId }) => deleteSessions([sessionId]),
        'session.deleteMany': ({ sessionIds }) => deleteSessions([...new Set(sessionIds)]),
        'project.delete': ({ projectId }) =>
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
                            return finish('project.delete');
                        }),
                );
            }),
    };
}
