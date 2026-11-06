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
    /**
     * Whether a Chat Terminal is a new Chat nobody used; see `AgentChatService.isUntouched`.
     */
    isUntouchedChat(terminalId: string): boolean;
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
): Pick<
    DomainHandlers,
    'session.delete' | 'session.deleteMany' | 'session.discardIfEmpty' | 'project.delete'
> {
    const { database } = options;
    const finish = (reason: 'session.delete' | 'project.delete', windowKey?: string) => {
        options.restoreSelection();
        options.send({ event: 'state.changed', payload: { kind: 'full', reason } });
        return options.bootstrapState(windowKey);
    };
    /**
     * A Session the user created and never used: a top-level Session (not a delegated or Bot one) whose every Terminal
     * is a Chat that never received input. A Session with no Terminal is not discardable, since the New Session flow
     * always creates one and anything else got there some other way.
     */
    const isDiscardable = (sessionId: string): boolean => {
        const session = database.getSession(sessionId);
        if (!session || session.createdBySessionId) return false;
        const terminals = database.listTerminals(sessionId);
        return (
            terminals.length > 0 &&
            terminals.every(
                (terminal) => terminal.surface === 'chat' && options.isUntouchedChat(terminal.id),
            )
        );
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
        'session.discardIfEmpty': async ({ sessionId, windowKey }) => {
            if (!isDiscardable(sessionId)) return { discarded: false };
            await deleteSessions([sessionId], windowKey);
            return { discarded: true };
        },
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
