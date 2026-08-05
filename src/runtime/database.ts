import type Database from 'better-sqlite3';

import { CaxriError } from '../shared/ipc/errors';
import type {
    AgentSnapshot,
    ProcessState,
    ProjectRecord,
    SessionRecord,
    SessionState,
    TerminalKind,
    TerminalRecord,
    TerminalSnapshot,
} from '../shared/types';
import {
    choosePrimaryAgentForNewTerminal,
    choosePrimaryAgentSuccessor,
    decideAgentMetadataUpdate,
    defaultTerminalTitle,
    processActivityState,
    selectFallbackAfterDeletion,
    withTerminalRemovedFromLayout,
} from './session-policy';
import { CaxriStore, MAX_TERMINALS_GLOBAL, MAX_TERMINALS_PER_SESSION } from './store';

/**
 * Facade kept close to the pre-split `Database` API so every consumer (bootstrap, Terminal manager,
 * File service, Agent coordinator, Diagnostics) needs no changes. `./store` (`CaxriStore`) owns
 * connection lifecycle and pure SQL; `./session-policy` owns the domain decisions; this class
 * composes the two per operation, each inside one transaction.
 */
export class CaxriDatabase {
    private readonly store: CaxriStore;

    constructor(path: string) {
        this.store = new CaxriStore(path);
    }

    /** Raw better-sqlite3 handle; integration tests inspect pragmas and `table_info` directly. */
    get database(): Database.Database {
        return this.store.database;
    }

    listProjects(): ProjectRecord[] {
        return this.store.projects.list();
    }

    getProject(id: string): ProjectRecord | undefined {
        return this.store.projects.get(id);
    }

    createProject(rootPath: string): ProjectRecord {
        return this.store.projects.create(rootPath);
    }

    deleteProject(projectId: string): void {
        this.store.transaction(() => {
            if (!this.store.projects.remove(projectId))
                throw new CaxriError('NOT_FOUND', 'Project not found');
            if (this.store.appState.get<string>('lastSelectedProjectId') !== projectId) return;
            const fallbackProject = this.store.projects.list().at(0);
            const fallbackSession = fallbackProject
                ? this.store.sessions.list(fallbackProject.id).at(0)
                : undefined;
            const selection = selectFallbackAfterDeletion(
                fallbackSession,
                fallbackProject?.id ?? null,
            );
            this.store.appState.set('lastSelectedProjectId', selection.projectId);
            this.store.appState.set('lastSelectedSessionId', selection.sessionId);
        });
    }

    listSessions(projectId?: string): SessionRecord[] {
        return this.store.sessions.list(projectId);
    }

    getSession(id: string): SessionRecord | undefined {
        return this.store.sessions.get(id);
    }

    updateAgentMetadata(terminalId: string, snapshot: AgentSnapshot): boolean {
        return this.store.transaction(() => {
            const terminal = this.store.terminals.get(terminalId);
            if (!terminal) return false;
            if (
                snapshot.sessionId &&
                this.store.terminals
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
            const session = this.store.sessions.get(terminal.sessionId);
            if (!session) return false;
            const decision = decideAgentMetadataUpdate(terminal, session, snapshot);
            if (!decision) return false;
            if (decision.sessionPatch)
                this.store.sessions.setDisplayTitleAndActivity(
                    session.id,
                    decision.sessionPatch.displayTitle,
                    decision.sessionPatch.lastActivityState,
                );
            this.store.terminals.updateAgentSessionId(terminal.id, decision.agentSessionId);
            return true;
        });
    }

    /** Agent session IDs are provider-owned identities and may belong to only one Terminal. */
    claimedAgentSessionIds(terminalId: string): string[] {
        const terminal = this.store.terminals.get(terminalId);
        if (!terminal?.provider) return [];
        return this.store.terminals
            .list()
            .filter(
                (candidate) =>
                    candidate.id !== terminalId &&
                    candidate.provider === terminal.provider &&
                    candidate.agentSessionId,
            )
            .map((candidate) => candidate.agentSessionId!);
    }

    isAgentSessionClaimedByOtherTerminal(terminalId: string, agentSessionId: string): boolean {
        return this.claimedAgentSessionIds(terminalId).includes(agentSessionId);
    }

    /** Clears the previous process binding so a restarted Agent cannot inherit its old session. */
    resetAgentMetadataForStart(terminalId: string, startedAt = Date.now()): void {
        this.store.transaction(() => {
            const terminal = this.store.terminals.get(terminalId);
            if (!terminal?.provider) return;
            this.store.terminals.updateAgentSessionId(terminalId, undefined, startedAt);
            const session = this.store.sessions.get(terminal.sessionId);
            if (session?.primaryAgentTerminalId === terminalId) {
                this.store.sessions.setDisplayTitleAndActivity(
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
        return this.store.transaction(() => {
            this.assertTerminalCapacity();
            const project = this.store.projects.get(projectId);
            if (!project) throw new CaxriError('NOT_FOUND', 'Project not found');
            const displayTitle = defaultTerminalTitle(kind);
            const session = this.store.sessions.insert({ projectId, displayTitle });
            const terminal = this.store.terminals.insert({
                sessionId: session.id,
                kind,
                cwd: project.rootPath,
                title: displayTitle,
            });
            const assignment = choosePrimaryAgentForNewTerminal(session, terminal);
            if (assignment) this.store.sessions.setPrimaryAgent(session.id, assignment);
            this.store.sessions.insertInitialState(session.id, terminal.id);
            this.store.appState.set('lastSelectedSessionId', session.id);
            this.store.appState.set('lastSelectedProjectId', projectId);
            this.store.projects.touchLastOpened(projectId);
            return {
                session: this.store.sessions.get(session.id)!,
                terminal: this.store.terminals.get(terminal.id)!,
            };
        });
    }

    selectSession(sessionId: string): void {
        this.store.transaction(() => {
            if (!this.store.sessions.touchLastOpened(sessionId))
                throw new CaxriError('NOT_FOUND', 'Session not found');
            const session = this.store.sessions.get(sessionId)!;
            this.store.projects.touchLastOpened(session.projectId);
            this.store.appState.set('lastSelectedSessionId', sessionId);
            this.store.appState.set('lastSelectedProjectId', session.projectId);
        });
    }

    deleteSession(sessionId: string): void {
        this.store.transaction(() => {
            if (!this.store.sessions.remove(sessionId))
                throw new CaxriError('NOT_FOUND', 'Session not found');
            if (this.store.appState.get<string>('lastSelectedSessionId') !== sessionId) return;
            const selectedProjectId = this.store.appState.get<string>('lastSelectedProjectId');
            const candidateSessions = selectedProjectId
                ? this.store.sessions.list(selectedProjectId)
                : this.store.sessions.list();
            const selection = selectFallbackAfterDeletion(
                candidateSessions.at(0),
                selectedProjectId ?? null,
            );
            this.store.appState.set('lastSelectedSessionId', selection.sessionId);
            this.store.appState.set('lastSelectedProjectId', selection.projectId);
        });
    }

    listTerminals(sessionId?: string): TerminalRecord[] {
        return this.store.terminals.list(sessionId);
    }

    getTerminal(id: string): TerminalRecord | undefined {
        return this.store.terminals.get(id);
    }

    createTerminal(sessionId: string, kind: TerminalKind): TerminalRecord {
        return this.store.transaction(() => {
            const session = this.store.sessions.get(sessionId);
            if (!session) throw new CaxriError('NOT_FOUND', 'Session not found');
            this.assertTerminalCapacity(sessionId);
            const terminal = this.store.terminals.insert({
                sessionId,
                kind,
                cwd: session.rootPath,
                title: defaultTerminalTitle(kind),
            });
            const assignment = choosePrimaryAgentForNewTerminal(session, terminal);
            if (assignment) this.store.sessions.setPrimaryAgent(sessionId, assignment);
            return terminal;
        });
    }

    private assertTerminalCapacity(sessionId?: string): void {
        if (this.store.terminals.countAll() >= MAX_TERMINALS_GLOBAL)
            throw new CaxriError(
                'CAPACITY',
                `Caxri supports at most ${MAX_TERMINALS_GLOBAL} Terminals`,
            );
        if (
            sessionId &&
            this.store.terminals.countForSession(sessionId) >= MAX_TERMINALS_PER_SESSION
        ) {
            throw new CaxriError(
                'CAPACITY',
                `A Session supports at most ${MAX_TERMINALS_PER_SESSION} Terminals`,
            );
        }
    }

    updateTerminalState(id: string, state: ProcessState): void {
        this.store.transaction(() => {
            const terminal = this.store.terminals.get(id);
            if (!terminal) return;
            this.store.terminals.updateState(id, state);
            if (terminal.provider)
                this.store.sessions.setActivityStateByPrimaryTerminal(
                    id,
                    processActivityState(state),
                );
        });
    }

    closeTerminal(id: string): void {
        this.store.transaction(() => {
            const terminal = this.store.terminals.get(id);
            if (!terminal) return;
            this.store.terminals.remove(id);
            const session = this.store.sessions.get(terminal.sessionId);
            if (session?.primaryAgentTerminalId === id) {
                const remaining = this.store.terminals.list(terminal.sessionId);
                const succession = choosePrimaryAgentSuccessor(remaining);
                this.store.sessions.setPrimaryAgent(terminal.sessionId, succession);
            }
            const state = this.store.sessions.getState(terminal.sessionId);
            this.store.sessions.updateState(withTerminalRemovedFromLayout(state, id));
        });
    }

    getSnapshot(terminalId: string): TerminalSnapshot | undefined {
        return this.store.snapshots.get(terminalId);
    }

    saveSnapshot(snapshot: TerminalSnapshot): void {
        this.store.snapshots.save(snapshot);
    }

    listSessionStates(): SessionState[] {
        return this.store.sessions
            .list()
            .map((session) => this.store.sessions.getState(session.id));
    }

    getSessionState(sessionId: string): SessionState {
        return this.store.sessions.getState(sessionId);
    }

    updateSessionState(state: SessionState): void {
        this.store.sessions.updateState(state);
    }

    getAppState<T>(key: string): T | undefined {
        return this.store.appState.get<T>(key);
    }

    setAppState(key: string, value: unknown): void {
        this.store.appState.set(key, value);
    }

    markAllStopped(): void {
        this.store.markAllStopped();
    }

    close(): void {
        this.store.close();
    }
}
