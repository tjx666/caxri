import type Database from 'better-sqlite3';

import { CaxriError } from '../../shared/ipc/errors';
import type {
    AgentProvider,
    AgentSnapshot,
    ProcessState,
    ProjectRecord,
    SessionRecord,
    SessionState,
    TerminalKind,
    TerminalRecord,
    TerminalSnapshot,
} from '../../shared/types';
import {
    choosePrimaryAgentForNewTerminal,
    choosePrimaryAgentSuccessor,
    decideAgentMetadataUpdate,
    defaultTerminalTitle,
    processActivityState,
    selectFallbackAfterDeletion,
    type ShutdownReason,
    withTerminalRemovedFromLayout,
} from '../session-policy';
import {
    CaxriDb,
    type CaxriDbOptions,
    MAX_TERMINALS_GLOBAL,
    MAX_TERMINALS_PER_SESSION,
} from './index';

/**
 * Facade kept close to the pre-split `Database` API so every consumer (bootstrap, Terminal manager,
 * File service, Agent coordinator, Diagnostics) needs no changes. `./index` (`CaxriDb`) owns
 * connection lifecycle and pure SQL; `../session-policy` owns the domain decisions; this class
 * composes the two per operation, each inside one transaction.
 */
export class CaxriDatabase {
    private readonly db: CaxriDb;

    constructor(path: string, options?: CaxriDbOptions) {
        this.db = new CaxriDb(path, options);
    }

    /** Raw better-sqlite3 handle; integration tests inspect pragmas and `table_info` directly. */
    get database(): Database.Database {
        return this.db.database;
    }

    listProjects(): ProjectRecord[] {
        return this.db.projects.list();
    }

    getProject(id: string): ProjectRecord | undefined {
        return this.db.projects.get(id);
    }

    createProject(rootPath: string): ProjectRecord {
        return this.db.projects.create(rootPath);
    }

    deleteProject(projectId: string): void {
        this.db.transaction(() => {
            if (!this.db.projects.remove(projectId))
                throw new CaxriError('NOT_FOUND', 'Project not found');
            if (this.db.appState.get<string>('lastSelectedProjectId') !== projectId) return;
            const fallbackProject = this.db.projects.list().at(0);
            const fallbackSession = fallbackProject
                ? this.db.sessions
                      .list(fallbackProject.id)
                      .find((session) => session.archivedAt === undefined)
                : undefined;
            const selection = selectFallbackAfterDeletion(
                fallbackSession,
                fallbackProject?.id ?? null,
            );
            this.db.appState.set('lastSelectedProjectId', selection.projectId);
            this.db.appState.set('lastSelectedSessionId', selection.sessionId);
        });
    }

    listSessions(projectId?: string): SessionRecord[] {
        return this.db.sessions.list(projectId);
    }

    getSession(id: string): SessionRecord | undefined {
        return this.db.sessions.get(id);
    }

    updateAgentMetadata(terminalId: string, snapshot: AgentSnapshot): boolean {
        return this.db.transaction(() => {
            const terminal = this.db.terminals.get(terminalId);
            if (!terminal) return false;
            if (
                snapshot.sessionId &&
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
            const decision = decideAgentMetadataUpdate(terminal, session, snapshot);
            if (!decision) return false;
            if (decision.sessionPatch)
                this.db.sessions.setDisplayTitleAndActivity(
                    session.id,
                    decision.sessionPatch.displayTitle,
                    decision.sessionPatch.lastActivityState,
                );
            this.db.terminals.updateAgentSessionId(terminal.id, decision.agentSessionId);
            return true;
        });
    }

    /**
     * Atomically reclassifies a live Shell after its foreground process confirms an Agent provider.
     * Optional metadata is committed in the same transaction when it already exists; otherwise the
     * Agent coordinator can publish the correct Terminal identity before the first provider session
     * record is written.
     */
    promoteShellToAgent(
        terminalId: string,
        provider: AgentProvider,
        snapshot?: AgentSnapshot,
    ): boolean {
        return this.db.transaction(() => {
            const terminal = this.db.terminals.get(terminalId);
            if (!terminal || terminal.kind !== 'shell' || terminal.provider) return false;
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
            if (decision.sessionPatch)
                this.db.sessions.setDisplayTitleAndActivity(
                    session.id,
                    decision.sessionPatch.displayTitle,
                    decision.sessionPatch.lastActivityState,
                );
            this.db.terminals.updateAgentSessionId(promoted.id, decision.agentSessionId);
            return true;
        });
    }

    /** Agent session IDs are provider-owned identities and may belong to only one Terminal. */
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

    /** Clears the previous process binding so a restarted Agent cannot inherit its old session. */
    resetAgentMetadataForStart(terminalId: string, startedAt = Date.now()): void {
        this.db.transaction(() => {
            const terminal = this.db.terminals.get(terminalId);
            if (!terminal?.provider) return;
            this.db.terminals.updateAgentSessionId(terminalId, undefined, startedAt);
            const session = this.db.sessions.get(terminal.sessionId);
            if (session?.primaryAgentTerminalId === terminalId) {
                this.db.sessions.setDisplayTitleAndActivity(
                    session.id,
                    defaultTerminalTitle(terminal.kind),
                    'running',
                );
            }
        });
    }

    createSession(
        projectId: string,
        kind: TerminalKind,
    ): { session: SessionRecord; terminal: TerminalRecord } {
        return this.db.transaction(() => {
            this.assertTerminalCapacity();
            const project = this.db.projects.get(projectId);
            if (!project) throw new CaxriError('NOT_FOUND', 'Project not found');
            const displayTitle = defaultTerminalTitle(kind);
            const session = this.db.sessions.insert({ projectId, displayTitle });
            const terminal = this.db.terminals.insert({
                sessionId: session.id,
                kind,
                cwd: project.rootPath,
                title: displayTitle,
            });
            const assignment = choosePrimaryAgentForNewTerminal(session, terminal);
            if (assignment) this.db.sessions.setPrimaryAgent(session.id, assignment);
            this.db.sessions.insertInitialState(session.id, terminal.id);
            this.db.appState.set('lastSelectedSessionId', session.id);
            this.db.appState.set('lastSelectedProjectId', projectId);
            this.db.projects.touchLastOpened(projectId);
            return {
                session: this.db.sessions.get(session.id)!,
                terminal: this.db.terminals.get(terminal.id)!,
            };
        });
    }

    selectSession(sessionId: string): void {
        this.db.transaction(() => {
            const session = this.db.sessions.get(sessionId);
            if (!session) throw new CaxriError('NOT_FOUND', 'Session not found');
            if (session.archivedAt !== undefined)
                throw new CaxriError('CONFLICT', 'Restore the archived Session before opening it');
            this.db.sessions.touchLastOpened(sessionId);
            this.db.projects.touchLastOpened(session.projectId);
            this.db.appState.set('lastSelectedSessionId', sessionId);
            this.db.appState.set('lastSelectedProjectId', session.projectId);
        });
    }

    deleteSession(sessionId: string): void {
        this.db.transaction(() => {
            if (!this.db.sessions.remove(sessionId))
                throw new CaxriError('NOT_FOUND', 'Session not found');
            if (this.db.appState.get<string>('lastSelectedSessionId') !== sessionId) return;
            const selectedProjectId = this.db.appState.get<string>('lastSelectedProjectId');
            const candidateSessions = selectedProjectId
                ? this.db.sessions.list(selectedProjectId)
                : this.db.sessions.list();
            const selection = selectFallbackAfterDeletion(
                candidateSessions.find((session) => session.archivedAt === undefined),
                selectedProjectId ?? null,
            );
            this.db.appState.set('lastSelectedSessionId', selection.sessionId);
            this.db.appState.set('lastSelectedProjectId', selection.projectId);
        });
    }

    /**
     * Archives a Session without touching its Terminal records or PTYs. If it was selected, active
     * navigation moves to another non-archived Session in the same Project, or leaves that Project
     * selected with no Session when none remain.
     */
    archiveSession(sessionId: string, now = Date.now()): SessionRecord {
        return this.db.transaction(() => {
            const session = this.db.sessions.get(sessionId);
            if (!session) throw new CaxriError('NOT_FOUND', 'Session not found');
            if (session.archivedAt === undefined && !this.db.sessions.setArchived(sessionId, now))
                throw new CaxriError('NOT_FOUND', 'Session not found');
            if (this.db.appState.get<string>('lastSelectedSessionId') === sessionId) {
                const fallback = this.db.sessions
                    .list(session.projectId)
                    .find(
                        (candidate) =>
                            candidate.id !== sessionId && candidate.archivedAt === undefined,
                    );
                const selection = selectFallbackAfterDeletion(fallback, session.projectId);
                this.db.appState.set('lastSelectedSessionId', selection.sessionId);
                this.db.appState.set('lastSelectedProjectId', selection.projectId);
            }
            return this.db.sessions.get(sessionId)!;
        });
    }

    /** Restores an archived Session to active navigation without selecting or restarting it. */
    unarchiveSession(sessionId: string): SessionRecord {
        return this.db.transaction(() => {
            const session = this.db.sessions.get(sessionId);
            if (!session) throw new CaxriError('NOT_FOUND', 'Session not found');
            if (session.archivedAt !== undefined && !this.db.sessions.setArchived(sessionId, null))
                throw new CaxriError('NOT_FOUND', 'Session not found');
            return this.db.sessions.get(sessionId)!;
        });
    }

    listTerminals(sessionId?: string): TerminalRecord[] {
        return this.db.terminals.list(sessionId);
    }

    getTerminal(id: string): TerminalRecord | undefined {
        return this.db.terminals.get(id);
    }

    createTerminal(sessionId: string, kind: TerminalKind): TerminalRecord {
        return this.db.transaction(() => {
            const session = this.db.sessions.get(sessionId);
            if (!session) throw new CaxriError('NOT_FOUND', 'Session not found');
            this.assertTerminalCapacity(sessionId);
            const terminal = this.db.terminals.insert({
                sessionId,
                kind,
                cwd: session.rootPath,
                title: defaultTerminalTitle(kind),
            });
            const assignment = choosePrimaryAgentForNewTerminal(session, terminal);
            if (assignment) this.db.sessions.setPrimaryAgent(sessionId, assignment);
            return terminal;
        });
    }

    private assertTerminalCapacity(sessionId?: string): void {
        if (this.db.terminals.countAll() >= MAX_TERMINALS_GLOBAL)
            throw new CaxriError(
                'CAPACITY',
                `Caxri supports at most ${MAX_TERMINALS_GLOBAL} Terminals`,
            );
        if (
            sessionId &&
            this.db.terminals.countForSession(sessionId) >= MAX_TERMINALS_PER_SESSION
        ) {
            throw new CaxriError(
                'CAPACITY',
                `A Session supports at most ${MAX_TERMINALS_PER_SESSION} Terminals`,
            );
        }
    }

    updateTerminalState(id: string, state: ProcessState): void {
        this.db.transaction(() => {
            const terminal = this.db.terminals.get(id);
            if (!terminal) return;
            this.db.terminals.updateState(id, state);
            if (terminal.provider)
                this.db.sessions.setActivityStateByPrimaryTerminal(id, processActivityState(state));
        });
    }

    closeTerminal(id: string): void {
        this.db.transaction(() => {
            const terminal = this.db.terminals.get(id);
            if (!terminal) return;
            this.db.terminals.remove(id);
            const session = this.db.sessions.get(terminal.sessionId);
            if (session?.primaryAgentTerminalId === id) {
                const remaining = this.db.terminals.list(terminal.sessionId);
                const succession = choosePrimaryAgentSuccessor(remaining);
                this.db.sessions.setPrimaryAgent(terminal.sessionId, succession);
            }
            const state = this.db.sessions.getState(terminal.sessionId);
            this.db.sessions.updateState(withTerminalRemovedFromLayout(state, id));
        });
    }

    getSnapshot(terminalId: string): TerminalSnapshot | undefined {
        return this.db.snapshots.get(terminalId);
    }

    saveSnapshot(snapshot: TerminalSnapshot): void {
        this.db.snapshots.save(snapshot);
    }

    listSessionStates(): SessionState[] {
        return this.db.sessions.listStates();
    }

    getSessionState(sessionId: string): SessionState {
        return this.db.sessions.getState(sessionId);
    }

    updateSessionState(state: SessionState): void {
        this.db.sessions.updateState(state);
    }

    getAppState<T>(key: string): T | undefined {
        return this.db.appState.get<T>(key);
    }

    setAppState(key: string, value: unknown): void {
        this.db.appState.set(key, value);
    }

    markShutdown(reason: ShutdownReason): void {
        this.db.markShutdown(reason);
    }

    close(): void {
        this.db.close();
    }
}
