// The filename should be `repo.ts` per unicorn/name-replacements, but renaming it requires
// updating imports across files/, agents/, git/, and root __tests__/ that other concurrent lint
// passes own; flagged for a coordinated repo-wide rename instead of a cross-scope edit here.
// eslint-disable-next-line unicorn/name-replacements
import type {
    AgentChatDefault,
    AgentChatPermission,
    AgentProvider,
    AgentSnapshot,
    ProcessState,
    ProjectIcon,
    ProjectRecord,
    SessionActivityReason,
    SessionRecord,
    SessionRestorePlacement,
    SessionState,
    TerminalFailureReason,
    TerminalKind,
    TerminalRecord,
    TerminalSnapshot,
    TerminalSurface,
} from '@caxri/protocol';
import {
    CaxriError,
    initialAgentChatPermission,
    resolveAgentChatPermissionChange,
} from '@caxri/protocol';
import type Database from 'better-sqlite3';

import type { AgentLifecycleSignal } from '../agents';
import { insertAgentDispatchWithTerminal } from './agent-dispatch-terminal';
import { AgentIdentity } from './agent-identity';
import type { AgentCommanderRows } from './commander-rows';
import { agentCommanderRows } from './commander-rows';
import type { CaxriDatabaseConnectionOptions as CaxriDatabaseOptions } from './database-connection';
import { CaxriDatabaseConnection as CaxriDatabase_ } from './database-connection';
import { ensureDelegationContext } from './delegation-context';
import type {
    AgentDispatchReceiptPatch,
    NewAgentDispatchReceipt,
    StoredAgentDispatchReceipt,
} from './models/agent-dispatch-receipts';
import type { AppStateKey, AppStateValue } from './models/app-state';
import type { SessionWorkbenchBinding } from './models/sessions';
import { selectInWindow, WindowOpenSessionsStore } from './open-sessions';
import {
    promoteLivePrimaryAgentSuccessor,
    removeTerminalWithSuccession,
} from './primary-agent-succession';
import type { ProjectDeletionScope } from './project-deletion';
import { deleteProjectMetadata, projectDeletionScope } from './project-deletion';
import { reorderProject } from './project-ordering';
import {
    hideProject,
    isRestorableProjectRoot,
    listOpenableSessionIds,
    listVisibleProjects,
    listVisibleSessions,
    reconcileWindowsAfterRemoval,
} from './project-visibility';
import { archiveOneSession, restoreArchivedSessions } from './session-archive';
import type { CreateSessionOptions } from './session-create';
import { createSession as createSessionRow } from './session-create';
import { clearDeletedSessionCreators } from './session-creator';
import {
    reorderPinnedSession,
    reorderSessionInProject,
    setSessionPinned,
} from './session-ordering';
import type { ShutdownReason } from './session-policy';
import {
    choosePrimaryAgentForNewTerminal,
    defaultTerminalTitle,
    firstActiveSession,
    processExitActivityState,
    sessionActivityReasonForAgentState,
    shutdownOutcome,
} from './session-policy';
import { renameSessionWithPrimaryAgentTab } from './session-title';
import { assertTerminalCapacity } from './terminal-capacity';
import { terminalIdsBySession } from './terminal-ids-by-session';
import { moveTerminalToNewSession } from './terminal-move';
import { TerminalSurfaces } from './terminal-surface';

/**
 * Facade kept close to the pre-split `Database` API so every consumer (composition root, Terminal manager, File
 * service, Agent coordinator, Diagnostics) needs no changes. `./index` (`CaxriDatabaseConnection`) owns connection
 * lifecycle and pure SQL; `../session-policy` owns the domain decisions; this class composes the two per operation,
 * each inside one transaction.
 */
export class CaxriDatabase {
    private readonly db: CaxriDatabase_;
    private readonly agentIdentity: AgentIdentity;
    readonly protocolState: CaxriDatabase_['protocolState'];
    readonly mobileAgentSubmitReceipts: CaxriDatabase_['mobileAgentSubmitReceipts'];
    readonly agentDelegations: CaxriDatabase_['agentDelegations'];
    readonly agentSessionUsage: CaxriDatabase_['agentSessionUsage'];
    readonly commanderInbox: CaxriDatabase_['commanderInbox'];
    readonly commanderTasks: CaxriDatabase_['commanderTasks'];
    readonly commanderPendingNotices: CaxriDatabase_['commanderPendingNotices'];
    readonly terminalSurfaces: TerminalSurfaces;
    readonly windowOpenSessions: WindowOpenSessionsStore;

    constructor(path: string, options?: CaxriDatabaseOptions) {
        this.db = new CaxriDatabase_(path, options);
        this.agentIdentity = new AgentIdentity(this.db);
        this.protocolState = this.db.protocolState;
        this.mobileAgentSubmitReceipts = this.db.mobileAgentSubmitReceipts;
        this.agentDelegations = this.db.agentDelegations;
        this.agentSessionUsage = this.db.agentSessionUsage;
        this.commanderInbox = this.db.commanderInbox;
        this.commanderTasks = this.db.commanderTasks;
        this.commanderPendingNotices = this.db.commanderPendingNotices;
        this.terminalSurfaces = new TerminalSurfaces(this.db);
        this.windowOpenSessions = new WindowOpenSessionsStore(this.db, listOpenableSessionIds);
    }

    private insertTerminal(
        sessionId: string,
        kind: TerminalKind,
        cwd?: string,
        surface?: TerminalSurface,
    ): TerminalRecord {
        const session = this.db.sessions.get(sessionId);
        if (!session) throw new CaxriError('NOT_FOUND', 'Session not found');
        const ownerProject = this.db.projects.get(session.projectId);
        if (!ownerProject) throw new CaxriError('NOT_FOUND', 'Project not found');
        assertTerminalCapacity(this.db.terminals, sessionId);
        const terminal = this.db.terminals.insert({
            sessionId,
            kind,
            cwd: cwd ?? ownerProject.rootPath,
            surface,
            title: defaultTerminalTitle(kind),
            ...(surface === 'chat' &&
                kind !== 'shell' && {
                    chatPermission: initialAgentChatPermission(kind, ownerProject.chatDefaults),
                }),
        });
        const assignment = choosePrimaryAgentForNewTerminal(session, terminal);
        if (assignment) this.db.sessions.setPrimaryAgent(sessionId, assignment);
        this.db.sessions.addTerminalToAllRootStates(sessionId, terminal.id);
        return terminal;
    }

    /**
     * Raw better-sqlite3 handle; integration tests inspect pragmas and `table_info` directly.
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

    ensureDelegationContext(rootPath: string, provider: AgentProvider, isRegisterProject: boolean) {
        return ensureDelegationContext(
            this.db,
            rootPath,
            provider,
            isRegisterProject,
            (projectId) => this.createSession(projectId, null).session,
        );
    }

    /**
     * Passing `ownerProjectId` records an automatic worktree registration performed on that owner's behalf; omitting it
     * is a manual add. `ProjectsModel.create` owns the one-way ownership rule.
     */
    createProject(rootPath: string, ownerProjectId?: string): ProjectRecord {
        return this.db.projects.create(rootPath, ownerProjectId);
    }

    /**
     * The Sessions a {@link deleteProject} call will affect; see {@link projectDeletionScope}.
     */
    projectDeletionScope(projectId: string): ProjectDeletionScope {
        return projectDeletionScope(this.db, projectId);
    }

    setProjectChatDefault(
        projectId: string,
        provider: AgentProvider,
        chatDefault: AgentChatDefault | null,
    ): ProjectRecord {
        // A default must be one the provider offers, the same check a Chat's own switch gets.
        if (chatDefault)
            resolveAgentChatPermissionChange(provider, { planMode: false }, chatDefault);
        if (!this.db.projects.setChatDefault(projectId, provider, chatDefault))
            throw new CaxriError('NOT_FOUND', 'Project not found');
        return this.db.projects.get(projectId)!;
    }

    setProjectIcon(projectId: string, icon: ProjectIcon | null): ProjectRecord {
        if (!this.db.projects.setIcon(projectId, icon))
            throw new CaxriError('NOT_FOUND', 'Project not found');
        return this.db.projects.get(projectId)!;
    }

    /**
     * Moves one current Project atomically so Renderer input stays scalar and cannot omit rows.
     *
     * `targetIndex` is a position among the Projects the PrimarySidebar actually renders, because that is the only
     * order a user can express. Auto-registered worktree Projects have no user-visible position, so they are excluded
     * from the move and re-appended after it; otherwise a hidden row sitting between two visible ones would silently
     * shift every drop one slot.
     */
    reorderProject(projectId: string, targetIndex: number): ProjectRecord[] {
        return this.db.transaction(() => reorderProject(this.db, projectId, targetIndex));
    }

    /**
     * Metadata only: no Project folder or user file is ever touched; see {@link deleteProjectMetadata}.
     */
    deleteProject(projectId: string): void {
        this.db.transaction(() => deleteProjectMetadata(this.db, projectId));
    }

    /**
     * Keeps every row; a later manual {@link createProject} of the same root un-hides.
     */
    hideProject(projectId: string, now = Date.now()): SessionRecord[] {
        return this.db.transaction(() => hideProject(this.db, projectId, now));
    }

    listVisibleProjects(): ProjectRecord[] {
        return listVisibleProjects(this.db);
    }

    isRestorableProjectRoot(rootPath: string): boolean {
        return isRestorableProjectRoot(this.db, rootPath);
    }

    listVisibleSessions(): SessionRecord[] {
        return listVisibleSessions(this.db);
    }

    agentCommanderRows(): AgentCommanderRows | undefined {
        return agentCommanderRows(this.db);
    }

    listSessions(projectId?: string): SessionRecord[] {
        return this.db.sessions.list(projectId);
    }

    reorderSession(
        sessionId: string,
        anchorSessionId: string,
        placement: 'before' | 'after',
    ): void {
        this.db.transaction(() =>
            reorderSessionInProject(this.db, sessionId, anchorSessionId, placement),
        );
    }

    reorderPinnedSession(
        sessionId: string,
        anchorSessionId: string,
        placement: 'before' | 'after',
    ): void {
        this.db.transaction(() =>
            reorderPinnedSession(this.db, sessionId, anchorSessionId, placement),
        );
    }

    setSessionPinned(sessionId: string, shouldPin: boolean): SessionRecord {
        return this.db.transaction(() => setSessionPinned(this.db, sessionId, shouldPin));
    }

    getSession(id: string): SessionRecord | undefined {
        return this.db.sessions.get(id);
    }

    touchSessionActivity(
        sessionId: string,
        reason: SessionActivityReason,
        now = Date.now(),
    ): boolean {
        return this.db.sessions.touchActivity(sessionId, reason, now);
    }

    consumeSessionAttentionReply(
        sessionId: string,
        terminalId: string,
        attentionEpoch: number,
    ): boolean {
        return this.db.sessions.consumeAttentionReply(sessionId, terminalId, attentionEpoch);
    }

    releaseSessionAttentionReply(
        sessionId: string,
        terminalId: string,
        attentionEpoch: number,
        activityAt: number,
    ): boolean {
        return this.db.sessions.releaseAttentionReply(
            sessionId,
            terminalId,
            attentionEpoch,
            activityAt,
        );
    }

    getSessionWorkbenchBinding(id: string): SessionWorkbenchBinding | undefined {
        return this.db.sessions.getWorkbenchBinding(id);
    }

    /**
     * Sessions bound to `projectId` as their Workbench Root, archived ones included.
     */
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
        return renameSessionWithPrimaryAgentTab(this.db, sessionId, displayTitle);
    }

    automaticSessionNaming(sessionId: string) {
        return this.db.sessions.automaticNaming(sessionId);
    }

    setAutomaticSessionNaming(
        sessionId: string,
        value: NonNullable<ReturnType<CaxriDatabase['automaticSessionNaming']>>,
        displayTitle?: string,
    ): boolean {
        return this.db.sessions.setAutomaticNaming(sessionId, value, displayTitle);
    }

    updateAgentMetadata(
        terminalId: string,
        snapshot: AgentSnapshot,
        shouldRecordSessionActivity = false,
    ): boolean {
        return this.agentIdentity.updateAgentMetadata(
            terminalId,
            snapshot,
            shouldRecordSessionActivity,
        );
    }

    updateAgentLifecycle(signal: AgentLifecycleSignal): boolean {
        return this.agentIdentity.updateAgentLifecycle(signal);
    }

    confirmForegroundAgentProvider(terminalId: string, provider: AgentProvider): boolean {
        return this.agentIdentity.confirmForegroundAgentProvider(terminalId, provider);
    }

    revokeForegroundAgentProvider(terminalId: string, provider: AgentProvider): boolean {
        return this.db.transaction(() => {
            if (!this.agentIdentity.revokeForegroundAgentProvider(terminalId, provider))
                return false;
            promoteLivePrimaryAgentSuccessor(this.db, terminalId);
            return true;
        });
    }

    promoteShellToAgent(
        terminalId: string,
        provider: AgentProvider,
        snapshot?: AgentSnapshot,
    ): boolean {
        return this.agentIdentity.promoteShellToAgent(terminalId, provider, snapshot);
    }

    claimedAgentSessionIds(terminalId: string): string[] {
        return this.agentIdentity.claimedAgentSessionIds(terminalId);
    }

    claimedAgentSessionIdsForProvider(
        provider: AgentProvider,
        excludingTerminalId: string,
    ): string[] {
        return this.agentIdentity.claimedAgentSessionIdsForProvider(provider, excludingTerminalId);
    }

    isAgentSessionClaimedByOtherTerminal(terminalId: string, agentSessionId: string): boolean {
        return this.agentIdentity.isAgentSessionClaimedByOtherTerminal(terminalId, agentSessionId);
    }

    rebindAgentSession(
        terminalId: string,
        provider: AgentProvider,
        agentSessionId: string,
    ): boolean {
        return this.agentIdentity.rebindAgentSession(terminalId, provider, agentSessionId);
    }

    setTerminalAgentCwd(
        terminalId: string,
        provider: AgentProvider,
        agentCwd: string | undefined,
    ): boolean {
        return this.agentIdentity.setTerminalAgentCwd(terminalId, provider, agentCwd);
    }

    resetAgentMetadataForStart(terminalId: string, startedAt = Date.now()): void {
        this.agentIdentity.resetAgentMetadataForStart(terminalId, startedAt);
    }

    /**
     * See {@link createSessionRow}.
     */
    createSession(
        projectId: string,
        kind: TerminalKind | null,
        cwd?: string,
        options: CreateSessionOptions = {},
    ): { session: SessionRecord; terminal: TerminalRecord | null } {
        return this.db.transaction(() => createSessionRow(this.db, projectId, kind, cwd, options));
    }

    /**
     * Moves a live Terminal (its PTY untouched) into a brand-new Session under the same Project, analogous to a browser
     * "move tab to new window". Mirrors `createSession`'s new-Session bootstrap and `closeTerminal`'s source-Session
     * cleanup, but in one transaction so the Terminal is never observably ownerless. The composition root must call
     * `TerminalManager.reassignSession` afterward to keep the live PTY cache's `sessionId` in sync: this DB call alone
     * does not touch the in-memory cache.
     */
    moveTerminalToNewSession(
        terminalId: string,
        windowKey?: string,
    ): ReturnType<typeof moveTerminalToNewSession> {
        return this.db.transaction(() => moveTerminalToNewSession(this.db, terminalId, windowKey));
    }

    selectSession(sessionId: string, windowKey?: string): { ownerWindowKey?: string } {
        return this.db.transaction(() => {
            const session = this.db.sessions.get(sessionId);
            if (!session) throw new CaxriError('NOT_FOUND', 'Session not found');
            if (session.archivedAt !== undefined)
                throw new CaxriError('CONFLICT', 'Restore the archived Session before opening it');
            this.db.sessions.touchLastOpened(sessionId);
            this.db.projects.touchLastOpened(session.projectId);
            this.db.appState.set('lastSelectedProjectId', session.projectId);
            return selectInWindow(this.db, windowKey, sessionId);
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
            clearDeletedSessionCreators(this.db);
            const projectId = this.db.appState.get('lastSelectedProjectId') ?? null;
            const sessions = projectId
                ? this.db.sessions.list(projectId)
                : listVisibleSessions(this.db);
            reconcileWindowsAfterRemoval(this.db, firstActiveSession(sessions), projectId);
        });
    }

    archiveSession(sessionId: string, now = Date.now()): SessionRecord {
        return archiveOneSession(this.db, sessionId, now);
    }

    unarchiveSessions(
        sessionIds: readonly string[],
        placement: SessionRestorePlacement = 'top',
    ): SessionRecord[] {
        return restoreArchivedSessions(this.db, sessionIds, placement);
    }

    listTerminals(sessionId?: string): TerminalRecord[] {
        return this.db.terminals.list(sessionId);
    }

    getTerminal(id: string): TerminalRecord | undefined {
        return this.db.terminals.get(id);
    }

    createTerminal(
        sessionId: string,
        kind: TerminalKind,
        cwd?: string,
        surface?: TerminalSurface,
    ): TerminalRecord {
        return this.db.transaction(() => this.insertTerminal(sessionId, kind, cwd, surface));
    }

    /**
     * Atomically binds a durable dispatch receipt to its new PTY or Chat Terminal before any Agent process can start,
     * refusing an archived Session; see {@link insertAgentDispatchWithTerminal}.
     */
    createAgentDispatchWithTerminal(
        input: NewAgentDispatchReceipt,
        kind: AgentProvider,
        { cwd, surface }: { cwd?: string; surface?: TerminalSurface } = {},
    ): { stored: StoredAgentDispatchReceipt; terminal: TerminalRecord } {
        return this.db.transaction(() =>
            insertAgentDispatchWithTerminal(this.db, input, () =>
                this.insertTerminal(input.sessionId, kind, cwd, surface),
            ),
        );
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

    /**
     * Updates only PTY lifecycle state. An interactive Agent process remains `running` while it waits at its prompt, so
     * process liveness cannot prove that the Agent is executing a turn. Session Activity is owned by validated
     * lifecycle signals, exact provider-turn reconciliation, and {@link updateTerminalExitState} for a real exit.
     */
    updateTerminalState(
        id: string,
        state: ProcessState,
        failureReason?: TerminalFailureReason,
        failureDetail?: string,
    ): void {
        this.db.transaction(() => {
            if (!this.db.terminals.get(id)) return;
            this.db.terminals.updateState(id, state, failureReason, failureDetail);
        });
    }

    updateAgentProcessState(id: string, state: ProcessState): void {
        this.db.transaction(() => this.db.terminals.updateAgentProcessState(id, state));
    }

    getChatPermission(id: string): AgentChatPermission | undefined {
        return this.db.terminals.getChatPermission(id);
    }

    setChatPermission(id: string, permission: AgentChatPermission): void {
        this.db.transaction(() => this.db.terminals.setChatPermission(id, permission));
    }

    updateAgentProcessExitState(id: string, state: 'dead' | 'stopped'): string | undefined {
        return this.db.transaction(() => {
            if (!this.db.terminals.get(id)) return;
            this.db.terminals.updateAgentProcessState(id, state);
            return promoteLivePrimaryAgentSuccessor(this.db, id);
        });
    }

    markAgentProcessesShutdown(reason: ShutdownReason): void {
        const { liveProcessStates, terminalProcessState } = shutdownOutcome(reason);
        this.db.transaction(() =>
            this.db.terminals.markAgentProcessesShutdown(liveProcessStates, terminalProcessState),
        );
    }

    /**
     * A real child-process exit is user-relevant completion/failure. Recovery, explicit close, restart preparation, and
     * orderly shutdown keep using {@link updateTerminalState} so they cannot fabricate Session Activity.
     */
    updateTerminalExitState(id: string, state: 'dead' | 'stopped'): string | undefined {
        return this.db.transaction(() => {
            const terminal = this.db.terminals.get(id);
            if (!terminal) return;
            this.db.terminals.updateState(id, state);
            if (!terminal.provider) return;
            const activityState = processExitActivityState(state);
            const activityReason = sessionActivityReasonForAgentState(activityState);
            return this.db.sessions.setActivityStateByPrimaryTerminal(
                id,
                activityState,
                activityReason,
            )
                ? terminal.sessionId
                : undefined;
        });
    }

    /**
     * Applies a PTY-reported (OSC 0/2) display title without replacing the Terminal's stable semantic title. Returns
     * whether anything actually changed so the caller can skip broadcasting a no-op; see `TerminalsModel.setPtyTitle`.
     */
    setTerminalPtyTitle(id: string, ptyTitle: string): boolean {
        return this.db.terminals.setPtyTitle(id, ptyTitle);
    }

    closeTerminal(id: string): void {
        this.db.transaction(() => removeTerminalWithSuccession(this.db, id));
    }

    getSnapshot(terminalId: string): TerminalSnapshot | undefined {
        return this.db.snapshots.get(terminalId);
    }

    saveSnapshot(snapshot: TerminalSnapshot): void {
        this.db.snapshots.save(snapshot);
    }

    listSessionStates(terminalRecords?: readonly TerminalRecord[]): SessionState[] {
        return this.db.sessions.listStates(
            terminalRecords && terminalIdsBySession(terminalRecords),
        );
    }

    getSessionState(sessionId: string): SessionState {
        return this.db.sessions.getState(sessionId);
    }

    updateSessionState(state: SessionState, reason?: 'clientWrite' | 'serviceWrite'): void {
        this.db.sessions.updateState(state, reason);
    }

    remapWorkbenchEditorState(
        ...arguments_: Parameters<CaxriDatabase_['remapWorkbenchEditorState']>
    ): number {
        return this.db.remapWorkbenchEditorState(...arguments_);
    }

    removeWorkbenchEditorPath(workbenchProjectId: string, path: string): number {
        return this.db.removeWorkbenchEditorPath(workbenchProjectId, path);
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
