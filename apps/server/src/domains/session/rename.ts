import type {
    AgentProvider,
    ServerEvent,
    SessionRecord,
    SessionRenameProviderSyncSkipReason,
} from '@caxri/protocol';
import { agentProviderCatalog, CaxriError, sessionRenameTitleSchema } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { AgentCoordinator, AgentService } from '../agents';
/**
 * Server domain boundaries require the owning public root; structure tests reject cross-domain deep imports.
 */
// react-doctor-disable-next-line react-doctor/no-barrel-import
import { agentProviderStateRoot, isBareIssueReferenceTitle } from '../agents';
import type { CaxriDatabase } from '../db';

const MAXIMUM_AGENT_TARGET_CHANGES = 3;

interface AgentRenameTarget {
    agentSessionId: string;
    cwd: string;
    provider: AgentProvider;
    terminalId: string;
}

/**
 * Serializes the complete native-provider plus SQLite rename sequence per Session. Without this queue, a slower earlier
 * provider request could overwrite a newer name after the newer request had already completed.
 */
export class SessionRenameQueue {
    private readonly tails = new Map<string, Promise<void>>();

    run<Result>(sessionId: string, rename: () => Promise<Result>): Promise<Result> {
        const previous = this.tails.get(sessionId) ?? Promise.resolve();
        // eslint-disable-next-line unicorn/prefer-await -- the next tail must be installed before another call enters
        const result = previous.then(rename);
        // eslint-disable-next-line unicorn/prefer-await -- the tail intentionally converts success/failure to completion
        const tail = result.then(() => {}).catch(() => {});
        this.tails.set(sessionId, tail);
        // eslint-disable-next-line no-void -- cleanup observes an already non-rejecting completion tail
        void tail.finally(() => {
            if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId);
        });
        return result;
    }
}

/**
 * Owns Session rename from exact primary-Agent identity resolution through provider synchronization and the durable
 * Caxri title update.
 */
export class SessionRenameService {
    private static isSameTarget(first: AgentRenameTarget, second: AgentRenameTarget): boolean {
        return (
            first.terminalId === second.terminalId &&
            first.provider === second.provider &&
            first.agentSessionId === second.agentSessionId &&
            first.cwd === second.cwd
        );
    }

    private readonly manualRevisions = new Map<string, number>();

    constructor(
        private readonly database: CaxriDatabase,
        private readonly agents: AgentService,
        private readonly coordinator: AgentCoordinator,
        private readonly emit: (event: ServerEvent) => void,
        private readonly logger: StructuredLogger,
        private readonly queue = new SessionRenameQueue(),
    ) {}

    /**
     * Records why this rename reaches the Agent no further than Caxri's own database. Every caller still commits the
     * title locally, and `renameSession` marks the Session manually titled, so automatic naming cannot overwrite it.
     */
    private skipProviderSynchronization(
        provider: AgentProvider | undefined,
        reason: SessionRenameProviderSyncSkipReason,
    ): undefined {
        this.logger.write('info', logEventCatalog.sessionRename.providerSyncSkipped, {
            fields: { provider: provider ?? null, reason },
        });
        return;
    }

    private async primaryAgentTarget(sessionId: string): Promise<AgentRenameTarget | undefined> {
        const session = this.database.getSession(sessionId);
        if (!session) throw new CaxriError('NOT_FOUND', 'Session not found');
        if (!session.primaryAgentTerminalId) return undefined;
        let terminal = this.database.getTerminal(session.primaryAgentTerminalId);
        if (!terminal) throw new CaxriError('INTERNAL', 'Primary Agent Terminal is missing');
        if (!terminal.provider)
            throw new CaxriError('INTERNAL', 'Primary Agent Terminal has no provider');
        /**
         * A provider without rename integration is the same situation as an Agent that has not produced a session yet:
         * there is nothing to synchronize, which is an implementation fact rather than something the user did wrong.
         * Refusing here also contradicted the Session row itself: double-click and Enter never consulted the
         * capability, so the user typed a name, pressed Enter, and watched it vanish behind an error toast.
         */
        if (!agentProviderCatalog[terminal.provider].capabilities.nativeRename)
            return this.skipProviderSynchronization(
                terminal.provider,
                'provider-rename-unsupported',
            );
        if (!terminal.agentSessionId) {
            await this.coordinator.probeTerminalNow(terminal.id);
            const currentSession = this.database.getSession(sessionId);
            if (!currentSession) throw new CaxriError('NOT_FOUND', 'Session not found');
            if (!currentSession.primaryAgentTerminalId) return undefined;
            terminal = this.database.getTerminal(currentSession.primaryAgentTerminalId);
        }
        /**
         * A Terminal whose Agent has not produced a session yet (a Session the user opened and named before typing
         * anything) has nothing to synchronize, not a failure to report. Refusing the rename here made the very first
         * thing a user does to a new Session fail, and the name they typed was discarded with it. Skipping provider
         * sync still commits the title locally, and `renameSession` marks the Session manually titled, so automatic
         * naming will not overwrite it once the Agent does start.
         */
        if (!terminal?.agentSessionId)
            return this.skipProviderSynchronization(
                terminal?.provider,
                'agent-session-unidentified',
            );
        if (!terminal.provider)
            throw new CaxriError('INTERNAL', 'Primary Agent Terminal has no provider');
        return {
            agentSessionId: terminal.agentSessionId,
            cwd: agentProviderStateRoot(terminal),
            provider: terminal.provider,
            terminalId: terminal.id,
        };
    }

    private async apply(
        sessionId: string,
        displayTitle: string,
        signal?: AbortSignal,
        finalizeDurably?: <Result>(commit: () => Result) => Result,
    ): Promise<SessionRecord> {
        if (signal?.aborted)
            throw new CaxriError('CANCELLED', 'Session rename was cancelled before it started');
        const renamedTerminalIds = new Set<string>();
        let target = await this.primaryAgentTarget(sessionId);
        for (let attempt = 0; target; attempt += 1) {
            // eslint-disable-next-line no-await-in-loop -- changed targets must be renamed in observed order
            const renamed = await this.agents.renameSession(target.provider, {
                agentSessionId: target.agentSessionId,
                cwd: target.cwd,
                displayTitle,
                signal,
            });
            if (renamed.displayTitle !== displayTitle)
                this.logger.write('warn', logEventCatalog.sessionRename.providerTitleMismatch, {
                    fields: { provider: target.provider, sessionId },
                });
            renamedTerminalIds.add(target.terminalId);
            // eslint-disable-next-line no-await-in-loop -- each result must be checked against current Agent identity
            const currentTarget = await this.primaryAgentTarget(sessionId);
            if (!currentTarget || SessionRenameService.isSameTarget(target, currentTarget)) break;
            if (attempt + 1 >= MAXIMUM_AGENT_TARGET_CHANGES)
                throw new CaxriError(
                    'CONFLICT',
                    'The primary Agent changed repeatedly during Session rename',
                );
            target = currentTarget;
        }
        const commit = (): SessionRecord => {
            /**
             * The Session name is the user's exact request. A provider may choose a unique native fallback when the
             * requested name is already held by another live session; that fallback must not become Caxri's title.
             */
            const renamed = this.database.renameSession(sessionId, displayTitle);
            this.emit({
                event: 'state.changed',
                payload: {
                    kind: 'records',
                    sessionIds: [sessionId],
                    // `renameSession` retitles the primary Agent Terminal with the Session, and the Renderer refreshes
                    // Terminal records only for the ids named here.
                    terminalIds: renamed.primaryAgentTerminalId
                        ? [renamed.primaryAgentTerminalId]
                        : [],
                },
            });
            return renamed;
        };
        const renamed = finalizeDurably ? finalizeDurably(commit) : commit();
        for (const terminalId of renamedTerminalIds) this.coordinator.probeTerminal(terminalId);
        return renamed;
    }

    /**
     * Retires in-memory manual ownership for a Session whose durable record is about to be deleted.
     *
     * In-flight manual provider work remains owned by the rename queue. Deletion does not cancel a user-requested
     * provider rename, so the queue can finish its existing fencing sequence without leaving a revision behind for a
     * future Session lookup.
     */
    forgetSession(sessionId: string): void {
        this.manualRevisions.delete(sessionId);
    }

    revision(sessionId: string): number {
        return this.manualRevisions.get(sessionId) ?? 0;
    }

    /**
     * Automatic writes share the manual queue, but never follow a changed primary binding or claim manual ownership.
     */
    renameAutomatically(
        sessionId: string,
        target: AgentRenameTarget,
        displayTitle: string,
        canApply: () => boolean,
        signal: AbortSignal,
        expectedNativeTitle?: string,
    ): Promise<boolean> {
        return this.queue.run(sessionId, async () => {
            const isEligible = async (): Promise<boolean> => {
                if (
                    signal.aborted ||
                    !canApply() ||
                    this.database.getSession(sessionId)?.titleMode !== 'automatic'
                )
                    return false;
                const current = await this.primaryAgentTarget(sessionId);
                return Boolean(
                    current &&
                    SessionRenameService.isSameTarget(target, current) &&
                    canApply() &&
                    !signal.aborted,
                );
            };
            if (!(await isEligible())) return false;
            const snapshot = await this.agents.snapshot(target.provider, {
                rootPath: target.cwd,
                agentSessionId: target.agentSessionId,
            });
            if (!(await isEligible()) || snapshot.sessionId !== target.agentSessionId) return false;
            /**
             * A pre-generation read may be stale by the time this queued read completes. Never turn its old title into
             * a native write if the provider changed the name or established automatic provenance in between.
             */
            if (
                expectedNativeTitle !== undefined &&
                (snapshot.title !== expectedNativeTitle || snapshot.titleSource === 'automatic')
            )
                return false;
            let state = this.database.automaticSessionNaming(sessionId);
            if (state?.status === 'complete' || state?.status === 'stopped') return false;
            if (
                !state &&
                snapshot.title &&
                snapshot.titleSource !== 'automatic' &&
                (snapshot.titleSource === 'explicit' || !isBareIssueReferenceTitle(snapshot.title))
            ) {
                if (snapshot.titleSource === 'explicit') {
                    this.database.renameSession(sessionId, snapshot.title);
                } else {
                    /**
                     * Codex cannot identify who named its thread. Keep the native title authoritative without claiming
                     * manual ownership, so later native renames can still flow into Caxri.
                     */
                    this.database.setAutomaticSessionNaming(
                        sessionId,
                        {
                            ...target,
                            title: snapshot.title,
                            previousTitle: snapshot.title,
                            status: 'stopped',
                            updatedAt: Date.now(),
                        },
                        snapshot.title,
                    );
                    this.coordinator.probeTerminal(target.terminalId);
                }
                this.emit({
                    event: 'state.changed',
                    payload: {
                        kind: 'records',
                        sessionIds: [sessionId],
                        terminalIds: [target.terminalId],
                    },
                });
                return false;
            }
            if (
                state &&
                (state.agentSessionId !== target.agentSessionId ||
                    state.terminalId !== target.terminalId ||
                    state.cwd !== target.cwd ||
                    state.provider !== target.provider)
            ) {
                this.database.setAutomaticSessionNaming(sessionId, {
                    ...state,
                    status: 'stopped',
                    updatedAt: Date.now(),
                });
                return false;
            }
            if (
                state &&
                snapshot.title &&
                snapshot.title !== state.title &&
                snapshot.title !== state.previousTitle &&
                snapshot.titleSource !== 'automatic'
            ) {
                this.database.setAutomaticSessionNaming(sessionId, {
                    ...state,
                    status: 'stopped',
                    updatedAt: Date.now(),
                });
                return false;
            }
            state ??= {
                ...target,
                title: displayTitle,
                previousTitle: snapshot.title,
                status: 'pending',
                updatedAt: Date.now(),
            };
            this.database.setAutomaticSessionNaming(sessionId, state);
            /**
             * The pending intent survives a crash after provider success, so readback can finish without another
             * rename.
             */
            const renamed =
                snapshot.title === state.title
                    ? { displayTitle: state.title }
                    : await this.agents.renameSession(target.provider, {
                          ...target,
                          displayTitle: state.title,
                          signal,
                      });
            if (!(await isEligible())) return false;
            const applied = this.database.setAutomaticSessionNaming(
                sessionId,
                {
                    ...state,
                    title: renamed.displayTitle,
                    status: 'complete',
                    updatedAt: Date.now(),
                },
                renamed.displayTitle,
            );
            if (applied)
                this.emit({
                    event: 'state.changed',
                    payload: { kind: 'records', sessionIds: [sessionId], terminalIds: [] },
                });
            this.coordinator.probeTerminal(target.terminalId);
            return applied;
        });
    }

    rename(
        sessionId: string,
        displayTitle: string,
        signal?: AbortSignal,
        finalizeDurably?: <Result>(commit: () => Result) => Result,
    ): Promise<SessionRecord> {
        const parsedTitle = sessionRenameTitleSchema.safeParse(displayTitle);
        if (!parsedTitle.success)
            return Promise.reject(
                new CaxriError(
                    'VALIDATION',
                    parsedTitle.error.issues[0]?.message ?? 'Session name is invalid',
                ),
            );
        if (!this.database.getSession(sessionId))
            return Promise.reject(new CaxriError('NOT_FOUND', 'Session not found'));
        const normalizedTitle = parsedTitle.data;
        this.manualRevisions.set(sessionId, this.revision(sessionId) + 1);
        return this.queue.run(sessionId, () =>
            this.apply(sessionId, normalizedTitle, signal, finalizeDurably),
        );
    }
}
