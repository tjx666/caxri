// The filename should be `repo.ts` per unicorn/name-replacements, but renaming it requires
// updating imports across files/, agents/, git/, and root __tests__/ that other concurrent lint
// passes own; flagged for a coordinated repo-wide rename instead of a cross-scope edit here.
// eslint-disable-next-line unicorn/name-replacements
import type Database from 'better-sqlite3';

import { CaxriError } from '../../shared/ipc/errors';
import type {
    AgentProvider,
    AgentSnapshot,
    ProcessState,
    ProjectRecord,
    SessionRecord,
    SessionState,
    TerminalFailureReason,
    TerminalKind,
    TerminalRecord,
    TerminalSnapshot,
} from '../../shared/types';
import type { AgentLifecycleSignal } from '../agents';
import type { ShutdownReason } from '../session-policy';
import {
    choosePrimaryAgentForNewTerminal,
    choosePrimaryAgentSuccessor,
    decideAgentLifecycleUpdate,
    decideAgentMetadataUpdate,
    DEFAULT_SESSION_TITLE,
    defaultTerminalTitle,
    processActivityState,
    selectFallbackAfterDeletion,
    withTerminalRemovedFromLayout,
} from '../session-policy';
import type { CaxriDatabaseConnectionOptions as CaxriDatabaseOptions } from './index';
import {
    CaxriDatabaseConnection as CaxriDatabase_,
    MAX_TERMINALS_GLOBAL,
    MAX_TERMINALS_PER_SESSION,
} from './index';
import type {
    AgentDispatchReceiptPatch,
    NewAgentDispatchReceipt,
    StoredAgentDispatchReceipt,
} from './models/agent-dispatch-receipts';
import type { AppStateKey, AppStateValue } from './models/app-state';
import type { SessionWorkbenchBinding } from './models/sessions';

/**
 * Facade kept close to the pre-split `Database` API so every consumer (bootstrap, Terminal manager,
 * File service, Agent coordinator, Diagnostics) needs no changes. `./index` (`CaxriDatabaseConnection`) owns
 * connection lifecycle and pure SQL; `../session-policy` owns the domain decisions; this class
 * composes the two per operation, each inside one transaction.
 */
export class CaxriDatabase {
    private readonly db: CaxriDatabase_;

    constructor(path: string, options?: CaxriDatabaseOptions) {
        this.db = new CaxriDatabase_(path, options);
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

    private insertTerminal(sessionId: string, kind: TerminalKind, cwd?: string): TerminalRecord {
        const session = this.db.sessions.get(sessionId);
        if (!session) throw new CaxriError('NOT_FOUND', 'Session not found');
        const ownerProject = this.db.projects.get(session.projectId);
        if (!ownerProject) throw new CaxriError('NOT_FOUND', 'Project not found');
        this.assertTerminalCapacity(sessionId);
        const terminal = this.db.terminals.insert({
            sessionId,
            kind,
            cwd: cwd ?? ownerProject.rootPath,
            title: defaultTerminalTitle(kind),
        });
        const assignment = choosePrimaryAgentForNewTerminal(session, terminal);
        if (assignment) this.db.sessions.setPrimaryAgent(sessionId, assignment);
        return terminal;
    }

    /**
    Raw better-sqlite3 handle; integration tests inspect pragmas and `table_info` directly.
     */
    get database(): Database.Database {
        return this.db.database;
    }

    listProjects(): ProjectRecord[] {
        return this.db.projects.list();
    }

    getProject(id: string): ProjectRecord | undefined {
        return this.db.projects.get(id);
    }

    findProjectByRootPath(rootPath: string): ProjectRecord | undefined {
        return this.db.projects.findByRootPath(rootPath);
    }

    createProject(rootPath: string): ProjectRecord {
        return this.db.projects.create(rootPath);
    }

    /**
    Moves one current Project atomically so Renderer input stays scalar and cannot omit rows.
     */
    reorderProject(projectId: string, targetIndex: number): ProjectRecord[] {
        return this.db.transaction(() => {
            const currentIds = this.db.projects.list().map((project) => project.id);
            if (
                !currentIds.includes(projectId) ||
                !Number.isSafeInteger(targetIndex) ||
                targetIndex < 0 ||
                targetIndex >= currentIds.length
            ) {
                throw new CaxriError(
                    'VALIDATION',
                    'Project reorder must reference a current Project and valid position',
                );
            }
            const reordered = currentIds.filter((currentId) => currentId !== projectId);
            reordered.splice(targetIndex, 0, projectId);
            this.db.projects.reorder(reordered);
            return this.db.projects.list();
        });
    }

    deleteProject(projectId: string): void {
        this.db.transaction(() => {
            /**
             * The generated SQLite ALTER migration cannot attach ON DELETE SET NULL, so explicit
             *  fallback is part of the same transaction that removes the authorized Project.
             */
            this.db.sessions.resetWorkbenchProject(projectId);
            if (!this.db.projects.remove(projectId))
                throw new CaxriError('NOT_FOUND', 'Project not found');
            if (this.db.appState.get('lastSelectedProjectId') !== projectId) return;
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

    getSessionWorkbenchBinding(id: string): SessionWorkbenchBinding | undefined {
        return this.db.sessions.getWorkbenchBinding(id);
    }

    listSessionsUsingWorkbenchProject(projectId: string): SessionRecord[] {
        return this.db.sessions.listUsingWorkbenchProject(projectId);
    }

    selectWorkbenchProject(
        sessionId: string,
        projectId: string,
        identity?: { device: string; inode: string },
    ): SessionRecord {
        return this.db.transaction(() => {
            if (!this.db.projects.get(projectId))
                throw new CaxriError('NOT_FOUND', 'Workbench Project not found');
            if (!this.db.sessions.setWorkbenchProject(sessionId, projectId, identity))
                throw new CaxriError('NOT_FOUND', 'Session not found');
            return this.db.sessions.get(sessionId)!;
        });
    }

    renameSession(sessionId: string, displayTitle: string): SessionRecord {
        const normalizedTitle = displayTitle.trim();
        if (!normalizedTitle) throw new CaxriError('VALIDATION', 'Session name is required');
        if (!this.db.sessions.rename(sessionId, normalizedTitle))
            throw new CaxriError('NOT_FOUND', 'Session not found');
        return this.db.sessions.get(sessionId)!;
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
                    decision.sessionPatch.attentionKind,
                );
            this.db.terminals.updateAgentSessionId(terminal.id, decision.agentSessionId);
            return true;
        });
    }

    /**
    Applies a validated hook signal without touching Terminal-owned Agent session identity.
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
            );
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
                    decision.sessionPatch.attentionKind,
                );
            this.db.terminals.updateAgentSessionId(promoted.id, decision.agentSessionId);
            return true;
        });
    }

    /**
    Agent session IDs are provider-owned identities and may belong to only one Terminal.
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
    Clears the previous process binding so a restarted Agent cannot inherit its old session.
     */
    resetAgentMetadataForStart(terminalId: string, startedAt = Date.now()): void {
        this.db.transaction(() => {
            const terminal = this.db.terminals.get(terminalId);
            if (!terminal?.provider) return;
            this.db.terminals.updateAgentSessionId(terminalId, undefined, startedAt);
            const session = this.db.sessions.get(terminal.sessionId);
            if (session?.primaryAgentTerminalId === terminalId) {
                this.db.sessions.setDisplayTitleAndActivity(
                    session.id,
                    session.displayTitle,
                    'running',
                );
            }
        });
    }

    /**
    A `null` kind creates a Terminal-less Session — the same shape as one whose Terminals were all closed.
     */
    createSession(
        projectId: string,
        kind: TerminalKind | null,
        cwd?: string,
    ): { session: SessionRecord; terminal: TerminalRecord | null } {
        return this.db.transaction(() => {
            const project = this.db.projects.get(projectId);
            if (!project) throw new CaxriError('NOT_FOUND', 'Project not found');
            const session = this.db.sessions.insert({
                projectId,
                displayTitle: DEFAULT_SESSION_TITLE,
            });
            let terminal: TerminalRecord | null = null;
            if (kind) {
                this.assertTerminalCapacity();
                terminal = this.db.terminals.insert({
                    sessionId: session.id,
                    kind,
                    cwd: cwd ?? project.rootPath,
                    title: defaultTerminalTitle(kind),
                });
                const assignment = choosePrimaryAgentForNewTerminal(session, terminal);
                if (assignment) this.db.sessions.setPrimaryAgent(session.id, assignment);
            }
            this.db.sessions.insertInitialState(session.id, terminal?.id);
            this.db.appState.set('lastSelectedSessionId', session.id);
            this.db.appState.set('lastSelectedProjectId', projectId);
            this.db.projects.touchLastOpened(projectId);
            return {
                session: this.db.sessions.get(session.id)!,
                terminal: terminal ? this.db.terminals.get(terminal.id)! : null,
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

    markSessionAttentionRead(
        sessionId: string,
        attentionEpoch: number,
    ): { acknowledged: boolean; session: SessionRecord } {
        return this.db.transaction(() => {
            if (!this.db.sessions.get(sessionId))
                throw new CaxriError('NOT_FOUND', 'Session not found');
            const isAcknowledged = this.db.sessions.acknowledgeAttention(sessionId, attentionEpoch);
            return { acknowledged: isAcknowledged, session: this.db.sessions.get(sessionId)! };
        });
    }

    deleteSession(sessionId: string): void {
        this.db.transaction(() => {
            if (!this.db.sessions.remove(sessionId))
                throw new CaxriError('NOT_FOUND', 'Session not found');
            if (this.db.appState.get('lastSelectedSessionId') !== sessionId) return;
            const selectedProjectId = this.db.appState.get('lastSelectedProjectId');
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
            if (this.db.appState.get('lastSelectedSessionId') === sessionId) {
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

    /**
    Restores an archived Session to active navigation without selecting or restarting it.
     */
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

    createTerminal(sessionId: string, kind: TerminalKind, cwd?: string): TerminalRecord {
        return this.db.transaction(() => this.insertTerminal(sessionId, kind, cwd));
    }

    /**
    Atomically binds a durable dispatch receipt to its new Terminal before any PTY can spawn.
     */
    createAgentDispatchWithTerminal(
        input: NewAgentDispatchReceipt,
        kind: AgentProvider,
        cwd?: string,
    ): { stored: StoredAgentDispatchReceipt; terminal: TerminalRecord } {
        return this.db.transaction(() => {
            this.db.agentDispatchReceipts.insert(input);
            const terminal = this.insertTerminal(input.sessionId, kind, cwd);
            return {
                stored: this.db.agentDispatchReceipts.update(input.dispatchId, {
                    status: 'starting',
                    terminalId: terminal.id,
                    now: input.now,
                }),
                terminal,
            };
        });
    }

    createAgentDispatch(input: NewAgentDispatchReceipt): StoredAgentDispatchReceipt {
        return this.db.transaction(() => this.db.agentDispatchReceipts.insert(input));
    }

    getAgentDispatch(dispatchId: string): StoredAgentDispatchReceipt | undefined {
        return this.db.agentDispatchReceipts.get(dispatchId);
    }

    updateAgentDispatch(
        dispatchId: string,
        patch: AgentDispatchReceiptPatch,
    ): StoredAgentDispatchReceipt {
        return this.db.transaction(() => this.db.agentDispatchReceipts.update(dispatchId, patch));
    }

    activeAgentDispatches(): StoredAgentDispatchReceipt[] {
        return this.db.agentDispatchReceipts.active();
    }

    agentDispatchesForTerminal(terminalId: string): StoredAgentDispatchReceipt[] {
        return this.db.agentDispatchReceipts.forTerminal(terminalId);
    }

    updateTerminalState(
        id: string,
        state: ProcessState,
        failureReason?: TerminalFailureReason,
    ): void {
        this.db.transaction(() => {
            const terminal = this.db.terminals.get(id);
            if (!terminal) return;
            this.db.terminals.updateState(id, state, failureReason);
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
                const succession = choosePrimaryAgentSuccessor(remaining, session);
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

    remapWorkbenchEditorState(
        workbenchProjectId: string,
        operationId: string,
        previousPath: string,
        nextPath: string,
    ): number {
        return this.db.transaction(() =>
            this.db.sessions.remapWorkbenchEditorState(
                workbenchProjectId,
                operationId,
                previousPath,
                nextPath,
            ),
        );
    }

    getAppState<K extends AppStateKey>(key: K): AppStateValue<K> | undefined {
        return this.db.appState.get(key);
    }

    setAppState<K extends AppStateKey>(key: K, value: AppStateValue<K>): void {
        this.db.appState.set(key, value);
    }

    markShutdown(reason: ShutdownReason): void {
        this.db.markShutdown(reason);
    }

    close(): void {
        this.db.close();
    }
}
