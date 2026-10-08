// The filename should be `repo.ts` per unicorn/name-replacements, but renaming it requires
// updating imports across files/, agents/, git/, and root __tests__/ that other concurrent lint
// passes own; flagged for a coordinated repo-wide rename instead of a cross-scope edit here.
// eslint-disable-next-line unicorn/name-replacements
import type {
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
} from '@caxri/protocol';
import { CaxriError, isTopLevelProject } from '@caxri/protocol';
import type Database from 'better-sqlite3';

import type { AgentLifecycleSignal } from '../agents';
import type { ShutdownReason } from '../session-policy';
import {
    chooseLivePrimaryAgentSuccessor,
    choosePrimaryAgentForNewTerminal,
    choosePrimaryAgentSuccessor,
    DEFAULT_SESSION_TITLE,
    defaultTerminalTitle,
    firstActiveSession,
    processExitActivityState,
    selectFallbackAfterDeletion,
    sessionActivityReasonForAgentState,
    shutdownOutcome,
} from '../session-policy';
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
import {
    hideProject,
    isRestorableProjectRoot,
    listVisibleProjects,
    listVisibleSessions,
    moveSelectionOffProjects,
} from './project-visibility';
import { archiveOneSession, restoreArchivedSessions } from './session-archive';
import {
    reorderPinnedSession,
    reorderSessionInProject,
    setSessionPinned,
} from './session-ordering';
import { renameSessionWithPrimaryAgentTab } from './session-title';
import { assertTerminalCapacity } from './terminal-capacity';

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

    constructor(path: string, options?: CaxriDatabaseOptions) {
        this.db = new CaxriDatabase_(path, options);
        this.agentIdentity = new AgentIdentity(this.db);
        this.protocolState = this.db.protocolState;
        this.mobileAgentSubmitReceipts = this.db.mobileAgentSubmitReceipts;
        this.agentDelegations = this.db.agentDelegations;
    }

    private insertTerminal(sessionId: string, kind: TerminalKind, cwd?: string): TerminalRecord {
        const session = this.db.sessions.get(sessionId);
        if (!session) throw new CaxriError('NOT_FOUND', 'Session not found');
        const ownerProject = this.db.projects.get(session.projectId);
        if (!ownerProject) throw new CaxriError('NOT_FOUND', 'Project not found');
        assertTerminalCapacity(this.db.terminals, sessionId);
        const terminal = this.db.terminals.insert({
            sessionId,
            kind,
            cwd: cwd ?? ownerProject.rootPath,
            title: defaultTerminalTitle(kind),
        });
        const assignment = choosePrimaryAgentForNewTerminal(session, terminal);
        if (assignment) this.db.sessions.setPrimaryAgent(sessionId, assignment);
        this.db.sessions.addTerminalToAllRootStates(sessionId, terminal.id);
        return terminal;
    }

    private promoteLivePrimaryAgentSuccessor(exitedTerminalId: string): string | undefined {
        const terminal = this.db.terminals.get(exitedTerminalId);
        if (!terminal) return;
        const session = this.db.sessions.get(terminal.sessionId);
        if (!session) return;
        const succession = chooseLivePrimaryAgentSuccessor(
            this.db.terminals.list(terminal.sessionId),
            session,
            exitedTerminalId,
        );
        if (!succession) return;
        this.db.sessions.setPrimaryAgent(session.id, succession);
        return session.id;
    }

    /**
     * Every Project id a deletion of `projectId` removes: the Project itself plus the worktree Projects registered on
     * its behalf.
     */
    private deletedProjectIds(projectId: string): string[] {
        return [projectId, ...this.db.projects.listOwnedBy(projectId).map((owned) => owned.id)];
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
     * The Sessions a {@link deleteProject} call will affect, resolved before the deletion so runtime, Git, and status
     * caches can be evicted for exactly those Sessions.
     *
     * `owned` lists the Sessions belonging to the Project or to a worktree Project registered on its behalf; every one
     * of them is deleted. `workbench` lists the Sessions bound to any of those roots as their Workbench Root. The two
     * overlap: a Session in the deleted Project that had adopted one of its worktrees appears in both and is deleted.
     * Only a `workbench` Session owned by a Project that survives keeps existing, with its Workbench Root reset to its
     * own Project root.
     */
    projectDeletionScope(projectId: string): {
        owned: SessionRecord[];
        workbench: SessionRecord[];
    } {
        const projectIds = this.deletedProjectIds(projectId);
        return {
            owned: projectIds.flatMap((id) => this.db.sessions.list(id)),
            workbench: projectIds.flatMap((id) => this.db.sessions.listUsingWorkbenchProject(id)),
        };
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
        return this.db.transaction(() => {
            const current = this.db.projects.list();
            const visibleIds: string[] = [];
            const ownedIds: string[] = [];
            for (const project of current)
                (isTopLevelProject(project) ? visibleIds : ownedIds).push(project.id);
            if (
                !visibleIds.includes(projectId) ||
                !Number.isSafeInteger(targetIndex) ||
                targetIndex < 0 ||
                targetIndex >= visibleIds.length
            ) {
                throw new CaxriError(
                    'VALIDATION',
                    'Project reorder must reference a current Project and valid position',
                );
            }
            const reordered = visibleIds.filter((currentId) => currentId !== projectId);
            reordered.splice(targetIndex, 0, projectId);
            this.db.projects.reorder([...reordered, ...ownedIds]);
            return this.db.projects.list();
        });
    }

    /**
     * Metadata only: no Project folder or user file is ever touched. Worktree Projects auto-registered on this
     * Project's behalf are removed first, through the same per-Project routine, because the PrimarySidebar hides them
     * and no other path could ever delete them; their Sessions and Terminals cascade by foreign key exactly as the
     * owner's own do.
     */
    deleteProject(projectId: string): void {
        this.db.transaction(() => {
            const cascadedProjectIds = this.deletedProjectIds(projectId);
            /**
             * Foreign keys cascade the owned worktree Projects and every Session they own, and null
             * `sessions.workbench_project_id`. The Workbench root identity columns and the per-root JSON state are
             * beyond any foreign key, so each deleted root is cleared from them first.
             */
            for (const cascadedProjectId of cascadedProjectIds)
                this.db.sessions.resetWorkbenchProject(cascadedProjectId);
            if (!this.db.projects.remove(projectId))
                throw new CaxriError('NOT_FOUND', 'Project not found');
            moveSelectionOffProjects(this.db, cascadedProjectIds);
        });
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
            this.promoteLivePrimaryAgentSuccessor(terminalId);
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
     * Remote creation may preserve Desktop selection. Auto-registered worktree Projects cannot own Sessions: their
     * hidden rows offer no management UI; they can only be Workbench Roots of Sessions in the owning Project.
     */
    createSession(
        projectId: string,
        kind: TerminalKind | null,
        cwd?: string,
        options: { selection?: 'select' | 'preserve' } = {},
    ): { session: SessionRecord; terminal: TerminalRecord | null } {
        return this.db.transaction(() => {
            const project = this.db.projects.get(projectId);
            if (!project) throw new CaxriError('NOT_FOUND', 'Project not found');
            if (!isTopLevelProject(project))
                throw new CaxriError(
                    'CONFLICT',
                    'Sessions cannot be created inside an auto-registered worktree Project',
                );
            const session = this.db.sessions.insert({
                projectId,
                displayTitle: DEFAULT_SESSION_TITLE,
            });
            let terminal: TerminalRecord | null = null;
            if (kind) {
                assertTerminalCapacity(this.db.terminals);
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
            if (options.selection !== 'preserve') {
                this.db.appState.set('lastSelectedSessionId', session.id);
                this.db.appState.set('lastSelectedProjectId', projectId);
            }
            this.db.projects.touchLastOpened(projectId);
            return {
                session: this.db.sessions.get(session.id)!,
                terminal: terminal ? this.db.terminals.get(terminal.id)! : null,
            };
        });
    }

    /**
     * Moves a live Terminal (its PTY untouched) into a brand-new Session under the same Project, analogous to a browser
     * "move tab to new window". Mirrors `createSession`'s new-Session bootstrap and `closeTerminal`'s source-Session
     * cleanup, but in one transaction so the Terminal is never observably ownerless. The composition root must call
     * `TerminalManager.reassignSession` afterward to keep the live PTY cache's `sessionId` in sync: this DB call alone
     * does not touch the in-memory cache.
     */
    moveTerminalToNewSession(terminalId: string): {
        session: SessionRecord;
        terminal: TerminalRecord;
    } {
        return this.db.transaction(() => {
            const terminal = this.db.terminals.get(terminalId);
            if (!terminal) throw new CaxriError('NOT_FOUND', 'Terminal not found');
            const sourceSession = this.db.sessions.get(terminal.sessionId);
            if (!sourceSession) throw new CaxriError('NOT_FOUND', 'Session not found');
            const project = this.db.projects.get(sourceSession.projectId);
            if (!project) throw new CaxriError('NOT_FOUND', 'Project not found');

            const newSession = this.db.sessions.insert({
                projectId: sourceSession.projectId,
                displayTitle: DEFAULT_SESSION_TITLE,
            });

            this.db.terminals.reassignSession(terminalId, newSession.id);
            const movedTerminal = this.db.terminals.get(terminalId)!;

            // Source Session cleanup, mirroring `closeTerminal`.
            if (sourceSession.primaryAgentTerminalId === terminalId) {
                const remaining = this.db.terminals.list(sourceSession.id);
                const succession = choosePrimaryAgentSuccessor(remaining, sourceSession);
                this.db.sessions.setPrimaryAgent(sourceSession.id, succession);
            }
            this.db.sessions.removeTerminalFromAllRootStates(sourceSession.id, terminalId);

            // New Session state, mirroring `createSession`.
            const assignment = choosePrimaryAgentForNewTerminal(newSession, movedTerminal);
            if (assignment) this.db.sessions.setPrimaryAgent(newSession.id, assignment);
            this.db.sessions.insertInitialState(newSession.id, movedTerminal.id);

            this.db.appState.set('lastSelectedSessionId', newSession.id);
            this.db.appState.set('lastSelectedProjectId', project.id);
            this.db.projects.touchLastOpened(project.id);
            this.db.sessions.touchLastOpened(newSession.id);

            return {
                session: this.db.sessions.get(newSession.id)!,
                terminal: movedTerminal,
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
                : listVisibleSessions(this.db);
            const selection = selectFallbackAfterDeletion(
                firstActiveSession(candidateSessions),
                selectedProjectId ?? null,
            );
            this.db.appState.set('lastSelectedSessionId', selection.sessionId);
            this.db.appState.set('lastSelectedProjectId', selection.projectId);
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

    createTerminal(sessionId: string, kind: TerminalKind, cwd?: string): TerminalRecord {
        return this.db.transaction(() => this.insertTerminal(sessionId, kind, cwd));
    }

    /**
     * Atomically binds a durable dispatch receipt to its new Terminal before any PTY can spawn.
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

    updateAgentProcessExitState(id: string, state: 'dead' | 'stopped'): string | undefined {
        return this.db.transaction(() => {
            if (!this.db.terminals.get(id)) return;
            this.db.terminals.updateAgentProcessState(id, state);
            return this.promoteLivePrimaryAgentSuccessor(id);
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
        this.db.transaction(() => {
            const terminal = this.db.terminals.get(id);
            if (!terminal) return;
            /**
             * Read before removal: `primary_agent_terminal_id` is `ON DELETE SET NULL`, so afterwards the Session no
             * longer names the Terminal that needs a successor.
             */
            const session = this.db.sessions.get(terminal.sessionId);
            this.db.terminals.remove(id);
            if (session?.primaryAgentTerminalId === id) {
                const remaining = this.db.terminals.list(terminal.sessionId);
                const succession = choosePrimaryAgentSuccessor(remaining, session);
                this.db.sessions.setPrimaryAgent(terminal.sessionId, succession);
            }
            this.db.sessions.removeTerminalFromAllRootStates(terminal.sessionId, id);
        });
    }

    getSnapshot(terminalId: string): TerminalSnapshot | undefined {
        return this.db.snapshots.get(terminalId);
    }

    saveSnapshot(snapshot: TerminalSnapshot): void {
        this.db.snapshots.save(snapshot);
    }

    listSessionStates(terminalRecords?: readonly TerminalRecord[]): SessionState[] {
        if (!terminalRecords) return this.db.sessions.listStates();
        const terminalIdsBySession = new Map<string, string[]>();
        for (const terminal of terminalRecords) {
            const terminalIds = terminalIdsBySession.get(terminal.sessionId);
            if (terminalIds) terminalIds.push(terminal.id);
            else terminalIdsBySession.set(terminal.sessionId, [terminal.id]);
        }
        return this.db.sessions.listStates(terminalIdsBySession);
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
        return this.db.remapWorkbenchEditorState(
            workbenchProjectId,
            operationId,
            previousPath,
            nextPath,
        );
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
