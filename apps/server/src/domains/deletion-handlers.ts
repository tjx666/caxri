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
 * Bounds the rounds that fence Sessions created while a Project deletion waited; see `project.delete`.
 */
const maxProjectDeleteRounds = 4;

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
    /**
     * Removes the Sessions once the delegation fence and the mutation queue have waited. Both waits are asynchronous,
     * so anything that decided to delete before them (a discard check, a Project's Session list) may be stale by the
     * time `shouldProceed` runs; `shouldProceed` is the one synchronous point before the database delete and may veto
     * the removal by returning `false`.
     */
    const removeSessions = (
        sessionIds: readonly string[],
        windowKey: string | undefined,
        shouldProceed: () => boolean,
    ): Promise<BootstrapState | undefined> =>
        options.delegations.deleteSessions(sessionIds, () =>
            options.mobileTerminalMutations.runSessions(sessionIds, () => {
                if (!shouldProceed()) return;
                for (const id of sessionIds) options.forgetSessionRuntime(id);
                options.evictSessions(sessionIds);
                for (const id of sessionIds) database.deleteSession(id);
                return finish('session.delete', windowKey);
            }),
        );
    const deleteSessions = async (sessionIds: readonly string[], windowKey?: string) =>
        (await removeSessions(sessionIds, windowKey, () => true))!;
    return {
        'session.delete': ({ sessionId, windowKey }) => deleteSessions([sessionId], windowKey),
        'session.deleteMany': ({ sessionIds, windowKey }) =>
            deleteSessions([...new Set(sessionIds)], windowKey),
        'session.discardIfEmpty': async ({ sessionId, windowKey }) => {
            if (!isDiscardable(sessionId)) return { discarded: false };
            // Another connection can send the first message while the removal waits on the delegation fence and the
            // mutation queue, so the predicate is checked again at the point of deletion. A Session that received a
            // message must stay.
            const removed = await removeSessions([sessionId], windowKey, () =>
                isDiscardable(sessionId),
            );
            return { discarded: removed !== undefined };
        },
        'project.delete': ({ projectId, windowKey }) =>
            options.mobileTerminalMutations.runProject(projectId, () => {
                /**
                 * Retires the Project's Sessions behind the delegation fence and the mutation queue. Both waits are
                 * asynchronous, so a Session an Agent delegation creates meanwhile is missing from the scope read
                 * before them: the database cascade would delete its row while its delegation private files and pending
                 * questions and approvals survive. After the waits the scope is read again; Sessions the fence did not
                 * cover are fenced, cleaned and forgotten by one more round, nested inside this one, until a read finds
                 * nothing new. A round limit bounds a Project that keeps gaining Sessions; the last round then proceeds
                 * with the scope it read.
                 */
                const retire = (
                    scope: ReturnType<typeof database.projectDeletionScope>,
                    fenced: ReadonlySet<string>,
                    round: number,
                ): Promise<BootstrapState> => {
                    const owned = scope.owned.map((session) => session.id);
                    const affected = [
                        ...new Set(
                            [...scope.owned, ...scope.workbench].map((session) => session.id),
                        ),
                    ];
                    return options.delegations.deleteSessions(owned, () =>
                        options.mobileTerminalMutations.runSessions(affected, () => {
                            const fresh = database.projectDeletionScope(projectId);
                            const covered = new Set([...fenced, ...owned]);
                            if (
                                round < maxProjectDeleteRounds &&
                                fresh.owned.some((session) => !covered.has(session.id))
                            ) {
                                return retire(
                                    {
                                        owned: fresh.owned.filter(
                                            (session) => !covered.has(session.id),
                                        ),
                                        workbench: [],
                                    },
                                    covered,
                                    round + 1,
                                );
                            }
                            const freshAffected = [
                                ...new Set(
                                    [...fresh.owned, ...fresh.workbench].map(
                                        (session) => session.id,
                                    ),
                                ),
                            ];
                            for (const session of fresh.owned)
                                options.forgetSessionRuntime(session.id);
                            options.evictSessions(freshAffected);
                            database.deleteProject(projectId);
                            options.projectDeleted(fresh.workbench.map((session) => session.id));
                            options.projectMetadataDeleted?.();
                            return finish('project.delete', windowKey);
                        }),
                    );
                };
                return retire(database.projectDeletionScope(projectId), new Set(), 0);
            }),
    };
}
