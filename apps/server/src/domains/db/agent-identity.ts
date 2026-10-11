import type { AgentProvider, AgentSnapshot } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { AgentLifecycleSignal } from '../agents';
import type { CaxriDatabaseConnection } from './database-connection';
import {
    choosePrimaryAgentForNewTerminal,
    decideAgentLifecycleUpdate,
    decideAgentMetadataUpdate,
    defaultTerminalTitle,
    sessionActivityReasonForAgentState,
} from './session-policy';

/**
 * Agent-owned half of the `CaxriDatabase` facade: provider identity, conversation metadata, lifecycle activity, and the
 * Agent's reported working directory. Every operation composes `./database-connection` (pure SQL) with
 * `../session-policy` (pure decisions) inside one transaction, exactly as the facade does for Project, Session, and
 * Terminal work. `CaxriDatabase` owns the only instance and re-exposes each method, so consumers keep one entry point.
 */
export class AgentIdentity {
    private readonly db: CaxriDatabaseConnection;

    constructor(connection: CaxriDatabaseConnection) {
        this.db = connection;
    }

    updateAgentMetadata(
        terminalId: string,
        snapshot: AgentSnapshot,
        shouldRecordSessionActivity: boolean,
    ): boolean {
        return this.db.transaction(() => {
            const terminal = this.db.terminals.get(terminalId);
            if (!terminal) return false;
            /**
             * A snapshot for the Terminal's exact hook-bound identity may legitimately duplicate another Terminal that
             * resumed the same conversation. Only an unbound or different identity is still a heuristic claim.
             */
            if (
                snapshot.sessionId &&
                snapshot.sessionId !== terminal.agentSessionId &&
                this.db.terminals
                    .list()
                    .some(
                        (candidate) =>
                            candidate.id !== terminalId &&
                            candidate.provider === snapshot.provider &&
                            candidate.agentSessionId === snapshot.sessionId,
                    )
            ) {
                return false;
            }
            const session = this.db.sessions.get(terminal.sessionId);
            if (!session) return false;
            const naming = this.db.sessions.automaticNaming(session.id);
            const ownsTitle =
                naming &&
                session.titleMode === 'automatic' &&
                session.primaryAgentTerminalId === terminal.id;
            let projectedSnapshot = snapshot;
            if (ownsTitle && naming.status !== 'stopped') {
                const isSameBinding =
                    naming.terminalId === terminal.id &&
                    naming.agentSessionId === snapshot.sessionId &&
                    naming.provider === snapshot.provider;
                const externalRename =
                    isSameBinding &&
                    naming.status === 'complete' &&
                    snapshot.observedAt > naming.updatedAt &&
                    snapshot.title &&
                    snapshot.title !== naming.title &&
                    snapshot.titleSource === 'explicit';
                if (!isSameBinding && snapshot.sessionId) {
                    this.db.sessions.setAutomaticNaming(session.id, {
                        ...naming,
                        status: 'stopped',
                        updatedAt: Date.now(),
                    });
                } else if (externalRename) {
                    this.db.sessions.setAutomaticNaming(session.id, {
                        ...naming,
                        status: 'stopped',
                        updatedAt: Date.now(),
                    });
                    this.db.sessions.rename(session.id, snapshot.title!);
                } else if (
                    naming.status === 'pending' ||
                    snapshot.observedAt <= naming.updatedAt ||
                    snapshot.titleSource === 'automatic'
                )
                    projectedSnapshot = { ...snapshot, title: undefined };
            }
            const decision = decideAgentMetadataUpdate(terminal, session, projectedSnapshot);
            if (!decision) return false;
            if (decision.sessionPatch) {
                const activityReason =
                    shouldRecordSessionActivity &&
                    (session.lastActivityState !== decision.sessionPatch.lastActivityState ||
                        decision.sessionPatch.attentionKind)
                        ? sessionActivityReasonForAgentState(
                              decision.sessionPatch.lastActivityState,
                          )
                        : undefined;
                this.db.sessions.setDisplayTitleAndActivity(
                    session.id,
                    decision.sessionPatch.displayTitle,
                    decision.sessionPatch.lastActivityState,
                    decision.sessionPatch.attentionKind,
                    activityReason,
                );
            }
            if (decision.terminalTitle !== undefined)
                this.db.terminals.setTitle(terminal.id, decision.terminalTitle);
            this.db.terminals.updateAgentSessionId(terminal.id, decision.agentSessionId);
            return true;
        });
    }

    /**
     * Applies a validated hook signal without touching Terminal-owned Agent session identity.
     */
    updateAgentLifecycle(signal: AgentLifecycleSignal): boolean {
        return this.db.transaction(() => {
            const terminal = this.db.terminals.get(signal.terminalId);
            if (!terminal) return false;
            const session = this.db.sessions.get(terminal.sessionId);
            if (!session) return false;
            const decision = decideAgentLifecycleUpdate(
                terminal,
                session,
                signal.provider,
                signal.phase,
            );
            if (!decision) return false;
            this.db.sessions.setDisplayTitleAndActivity(
                session.id,
                session.displayTitle,
                decision.lastActivityState,
                decision.attentionKind,
                sessionActivityReasonForAgentState(decision.lastActivityState),
            );
            if (decision.supersedesUnreadAttention)
                this.db.sessions.acknowledgeAttention(session.id, session.attentionEpoch);
            return true;
        });
    }

    confirmForegroundAgentProvider(terminalId: string, provider: AgentProvider): boolean {
        return this.db.transaction(() => {
            const terminal = this.db.terminals.get(terminalId);
            if (!terminal?.provider) return false;
            if (terminal.provider === provider)
                return this.db.terminals.reactivateAgentProcess(terminalId, provider);
            return this.db.terminals.switchAgentProvider(
                terminalId,
                provider,
                defaultTerminalTitle(provider),
            );
        });
    }

    revokeForegroundAgentProvider(terminalId: string, provider: AgentProvider): boolean {
        return this.db.terminals.deactivateForegroundAgentProcess(terminalId, provider);
    }

    /**
     * Atomically reclassifies a live Shell after its foreground process confirms an Agent provider. Optional metadata
     * is committed in the same transaction when it already exists; otherwise the Agent coordinator can publish the
     * correct Terminal identity before the first provider session record is written.
     */
    promoteShellToAgent(
        terminalId: string,
        provider: AgentProvider,
        snapshot?: AgentSnapshot,
    ): boolean {
        return this.db.transaction(() => {
            const terminal = this.db.terminals.get(terminalId);
            if (terminal?.kind !== 'shell' || terminal.provider) return false;
            if (snapshot?.provider !== undefined && snapshot.provider !== provider) return false;
            const agentSessionId = snapshot?.sessionId?.trim();
            if (
                agentSessionId &&
                this.claimedAgentSessionIdsForProvider(provider, terminalId).includes(
                    agentSessionId,
                )
            )
                return false;
            const session = this.db.sessions.get(terminal.sessionId);
            if (!session) return false;
            if (
                !this.db.terminals.promoteShellToAgent(
                    terminal.id,
                    provider,
                    defaultTerminalTitle(provider),
                )
            ) {
                return false;
            }
            const promoted = this.db.terminals.get(terminal.id)!;
            const assignment = choosePrimaryAgentForNewTerminal(session, promoted);
            if (assignment) this.db.sessions.setPrimaryAgent(session.id, assignment);
            if (!snapshot) return true;
            const updatedSession = this.db.sessions.get(session.id)!;
            const decision = decideAgentMetadataUpdate(promoted, updatedSession, snapshot);
            if (!decision)
                throw new CaxriError('INTERNAL', 'Agent promotion produced no metadata update');
            /**
             * The submitted launch command already advanced Session Activity; promotion only binds Agent identity.
             */
            if (decision.sessionPatch)
                this.db.sessions.setDisplayTitleAndActivity(
                    session.id,
                    decision.sessionPatch.displayTitle,
                    decision.sessionPatch.lastActivityState,
                    decision.sessionPatch.attentionKind,
                );
            if (decision.terminalTitle !== undefined)
                this.db.terminals.setTitle(promoted.id, decision.terminalTitle);
            this.db.terminals.updateAgentSessionId(promoted.id, decision.agentSessionId);
            return true;
        });
    }

    /**
     * Returns identities that heuristic discovery must not assign to another Terminal. Exact authenticated hook signals
     * may still bind multiple Terminals to the same provider session when the user intentionally resumes it twice.
     */
    claimedAgentSessionIds(terminalId: string): string[] {
        const terminal = this.db.terminals.get(terminalId);
        if (!terminal?.provider) return [];
        return this.claimedAgentSessionIdsForProvider(terminal.provider, terminalId);
    }

    claimedAgentSessionIdsForProvider(
        provider: AgentProvider,
        excludingTerminalId: string,
    ): string[] {
        const claimed: string[] = [];
        for (const candidate of this.db.terminals.list())
            if (
                candidate.id !== excludingTerminalId &&
                candidate.provider === provider &&
                candidate.agentSessionId
            )
                claimed.push(candidate.agentSessionId);
        return claimed;
    }

    isAgentSessionClaimedByOtherTerminal(terminalId: string, agentSessionId: string): boolean {
        return this.claimedAgentSessionIds(terminalId).includes(agentSessionId);
    }

    /**
     * Rebinds a Terminal to the provider session a validated hook signal reports, so a manual in-terminal resume
     * updates identity (and, through the next metadata probe, the title). The hook is exact generation-scoped evidence,
     * so two Terminals may intentionally show the same provider session; uniqueness remains only a heuristic guard.
     */
    rebindAgentSession(
        terminalId: string,
        provider: AgentProvider,
        agentSessionId: string,
    ): boolean {
        return this.db.transaction(() => {
            const terminal = this.db.terminals.get(terminalId);
            if (!terminal || terminal.provider !== provider) return false;
            if (terminal.agentSessionId === agentSessionId) return false;
            this.db.terminals.updateAgentSessionId(terminalId, agentSessionId);
            return true;
        });
    }

    /**
     * Records that the hosted Agent moved off the Terminal's launch root, or clears the divergence when it returned.
     * The caller must already have proven `agentCwd` against the owning Project's Git worktree topology; this method
     * performs no path authorization and deliberately leaves `terminals.cwd` (the authorized launch root) untouched.
     */
    setTerminalAgentCwd(
        terminalId: string,
        provider: AgentProvider,
        agentCwd: string | undefined,
    ): boolean {
        return this.db.transaction(() => {
            const terminal = this.db.terminals.get(terminalId);
            if (!terminal || terminal.provider !== provider) return false;
            if (terminal.agentCwd === agentCwd) return false;
            return this.db.terminals.updateAgentCwd(terminalId, agentCwd);
        });
    }

    /**
     * Clears the previous process binding so a restarted Agent cannot inherit its old session.
     *
     * The tab title is part of that binding now that it carries the Agent's conversation name: leaving it in place
     * would show the retired conversation's name against a brand new one until the first probe of the replacement
     * happens to report a title of its own, and forever if it never does.
     *
     * A diverged Agent working directory belongs to the retired process too: the replacement starts in the Terminal's
     * launch root, so keeping the old worktree would point transcript resolution at the wrong provider directory.
     */
    resetAgentMetadataForStart(terminalId: string, startedAt: number): void {
        this.db.transaction(() => {
            const terminal = this.db.terminals.get(terminalId);
            if (!terminal?.provider) return;
            this.db.terminals.updateAgentSessionId(terminalId, undefined, startedAt);
            this.db.terminals.updateAgentCwd(terminalId, undefined, startedAt);
            this.db.terminals.setTitle(terminalId, defaultTerminalTitle(terminal.kind), startedAt);
        });
    }
}
