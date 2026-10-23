import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';

import type {
    NewWorktreeBehavior,
    ServerEvent,
    SessionRecord,
    WorkbenchRootOption,
} from '@caxri/protocol';
import { CaxriError, errorMessage } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog, SingleFlight } from '@caxri/system';

import type { AgentLifecycleSignal, AgentSignalDecision } from '../agents';
import type { CaxriDatabase } from '../db';
import type { GitService, GitWorktreeTopology } from '../git';
import { assertInsideRoot } from '../path-security';
import type { SessionTranscriptContext } from '../session';
import type { WorktreeProvenanceScope } from './provenance';
import {
    AgentWorktreeAttribution,
    BoundedSerialBatcher,
    isSameWorkbenchBinding,
    updateObservedAgentCwd,
} from './provenance';
import type { WorkbenchCandidate } from './root-candidates';
import { addWorkbenchCandidate } from './root-candidates';
import {
    discoverWorkbenchRoots,
    isSameWorkbenchRootIdentity,
    unavailableWorkbenchRoot,
    unavailableWorkbenchRoots,
    withConversationRanks,
    worktreeIdentityId,
} from './root-discovery';
import type { TopologyValidation } from './sweep';
import { sweepWorkbenchRoots } from './sweep';
import type { SweepTimer } from './sweep-timing';

const MAX_OBSERVED_AGENT_CWDS = 256;
const MAX_PENDING_DELETION_VALIDATIONS = 256;
const SHELL_VALIDATION_SETTLE_MS = 100;
const workbenchRootLogEvents = logEventCatalog.workbenchRoot;

interface WorkbenchRootServiceOptions {
    /**
     * Integration-test seam for replacing a root between its identity read and canonicalization.
     */
    beforeRootIdentityRealpath?: () => Promise<void>;
    behavior(): NewWorktreeBehavior;
    database: CaxriDatabase;
    emit(event: ServerEvent): void;
    git: GitService;
    logger: StructuredLogger;
    /**
     * Worktree clues from this Session's own conversation; omitted, the picker simply offers no leading group.
     */
    sessionContext?: (session: SessionRecord) => Promise<SessionTranscriptContext>;
}

/**
 * Owns the bridge from authenticated, generation-scoped Agent hooks to authoritative Git worktree topology. The hook
 * reports only bounded command intent and an opaque tool id; a path remains inert until paired before/after topology
 * reads prove one unique addition.
 */
export class WorkbenchRootService {
    private readonly candidates = new Map<string, WorkbenchCandidate>();
    private readonly deletionValidations: BoundedSerialBatcher<string>;
    /**
     * Last working directory each Terminal's Agent reported. Every hook event carries one, so this map exists to make
     * the overwhelmingly common "unchanged" case a pure lookup instead of a Git read.
     */
    private readonly observedAgentCwds = new Map<string, string>();
    private readonly topologyReads = new SingleFlight<string, GitWorktreeTopology>();
    private readonly worktreeAttribution: AgentWorktreeAttribution;
    private closed = false;
    private queue: Promise<void> = Promise.resolve();
    /**
     * All-Session sweeps run outside `queue`, so `close()` tracks them here to keep the database open until they stop.
     */
    private readonly sweeps = new Set<Promise<void>>();
    private onRootChanged?: (sessionId: string) => void;

    constructor(private readonly options: WorkbenchRootServiceOptions) {
        this.worktreeAttribution = new AgentWorktreeAttribution({
            followWorktree: (input, isStillAuthorized) =>
                this.followWorktree(input, isStillAuthorized),
            database: this.options.database,
            git: this.options.git,
            logger: this.options.logger,
            runQueued: (run) => this.runQueued(run),
        });
        this.deletionValidations = new BoundedSerialBatcher({
            capacity: MAX_PENDING_DELETION_VALIDATIONS,
            delayMs: SHELL_VALIDATION_SETTLE_MS,
            onCapacity: () =>
                this.options.logger.write('warn', workbenchRootLogEvents.validationDropped, {
                    fields: { reason: 'capacity' },
                }),
            run: (sessionIds) => this.runQueued(() => this.validateSessions(sessionIds)),
        });
    }

    /**
     * Builds a fail-fast promise chain so one bounded batch never dispatches concurrent Git reads or database changes.
     */
    private validateSessions(sessionIds: readonly string[]): Promise<void> {
        /* eslint-disable unicorn/prefer-await -- `await` inside an iteration would recreate the React Doctor warning, while this chain preserves the required serial ordering. */
        return sessionIds.reduce<Promise<void>>(
            (pending, sessionId) =>
                pending.then(() => this.validateSession(sessionId)).then(() => {}),
            Promise.resolve(),
        );
        /* eslint-enable unicorn/prefer-await */
    }

    private async validateBinding(
        sessionId: string,
        binding: NonNullable<ReturnType<CaxriDatabase['getSessionWorkbenchBinding']>>,
        topologyValidation?: TopologyValidation,
        timer?: SweepTimer,
    ): Promise<boolean> {
        const owner = this.options.database.getProject(binding.projectId);
        const active = this.options.database.getProject(binding.workbenchProjectId);
        let reason = 'valid';
        let drifted: { device: string; inode: string } | undefined;
        try {
            if (!owner || !active) reason = 'project_missing';
            else {
                const topology = topologyValidation
                    ? topologyValidation.status === 'available'
                        ? topologyValidation.topology
                        : undefined
                    : await this.loadTopology(owner.rootPath);
                if (!topology) throw new Error('Workbench topology is unavailable');
                if (topology.worktrees.every((worktree) => worktree.rootPath !== active.rootPath))
                    reason = 'topology_removed';
                else {
                    const identityStartedAt = timer?.mark() ?? 0;
                    const identity = await this.rootIdentity(active.rootPath);
                    timer?.rootIdentity(identityStartedAt);
                    if (isSameWorkbenchRootIdentity(binding, identity)) {
                        if (identity.device !== binding.rootDevice) drifted = identity;
                    } else reason = 'root_replaced';
                }
            }
        } catch {
            reason = 'root_unavailable';
        }
        /**
         * Validation crosses filesystem and Git boundaries. A newer selection wins if the captured binding changed
         * while either asynchronous check was in flight.
         */
        if (
            !isSameWorkbenchBinding(
                binding,
                this.options.database.getSessionWorkbenchBinding(sessionId),
            )
        )
            return false;
        if (reason === 'valid') {
            if (drifted) this.rebind(sessionId, binding.workbenchProjectId, drifted);
            return false;
        }
        this.fallback(sessionId, reason);
        return true;
    }

    /**
     * Re-anchors a surviving binding onto the current device number. The root is unchanged, so this deliberately
     * persists without publishing a root change: the Renderer has nothing to redraw and the Session must not flash a
     * notice for a reboot the user did not cause.
     */
    private rebind(
        sessionId: string,
        workbenchProjectId: string,
        identity: { device: string; inode: string },
    ): void {
        this.options.database.selectWorkbenchProject(sessionId, workbenchProjectId, identity);
        this.options.logger.write('info', workbenchRootLogEvents.rebound, {
            fields: { reason: 'device_drift', sessionId, workbenchProjectId },
        });
    }

    /**
     * Reassigns the queue synchronously so launch baselines and paired tool snapshots remain ordered. The returned task
     * retains its own failure while the durable queue logs and continues.
     */
    private runQueued<T>(run: () => Promise<T>): Promise<T> {
        if (this.closed)
            return Promise.reject(
                new CaxriError('UNAVAILABLE', 'Workbench Root service is closed'),
            );
        /* eslint-disable unicorn/prefer-await -- synchronous queue reassignment is the serialization boundary. */
        const result = this.queue.then(() => {
            if (this.closed)
                throw new CaxriError('UNAVAILABLE', 'Workbench Root service is closed');
            return run();
        });
        this.queue = result
            .then(() => {})
            .catch((error: unknown) => {
                if (!this.closed)
                    this.options.logger.write('warn', workbenchRootLogEvents.topologyFailed, {
                        fields: { error: errorMessage(error, 'unknown') },
                    });
            });
        /* eslint-enable unicorn/prefer-await */
        return result;
    }

    private addCandidate(input: {
        repositoryKey: string;
        rootPath: string;
        sessionId: string;
    }): void {
        addWorkbenchCandidate(this.candidates, input, (event) => this.options.emit(event));
    }

    private loadTopology(ownerRoot: string): Promise<GitWorktreeTopology> {
        return this.topologyReads.run(ownerRoot, () =>
            this.options.git.worktreeTopology(ownerRoot),
        );
    }

    private fallback(sessionId: string, fallbackReason: string): void {
        const session = this.requireSession(sessionId);
        const owner = this.requireProject(session.projectId);
        const selected = this.options.database.selectWorkbenchProject(sessionId, owner.id);
        this.publishChange(selected, 'fallback', fallbackReason);
    }

    private publishChange(
        session: SessionRecord,
        reason: 'selected' | 'authorized' | 'followed' | 'fallback',
        fallbackReason?: string,
    ): void {
        const owner = this.requireProject(session.projectId);
        const followed =
            reason === 'followed' && this.options.database.getProject(session.workbenchProjectId);
        this.onRootChanged?.(session.id);
        this.options.emit({
            event: 'state.changed',
            payload: { kind: 'full', reason: 'session.workbenchRoot' },
        });
        this.options.emit({
            event: 'workbench.changed',
            payload: {
                sessionId: session.id,
                workbenchProjectId: session.workbenchProjectId,
                reason,
                ...(followed && { followedProjectTitle: followed.displayTitle }),
                ...(reason === 'fallback' && { returnedProjectTitle: owner.displayTitle }),
            },
        });
        if (fallbackReason)
            this.options.logger.write('warn', workbenchRootLogEvents.fallback, {
                fields: { reason: fallbackReason, sessionId: session.id },
            });
    }

    private async rootIdentity(rootPath: string): Promise<{ device: string; inode: string }> {
        const stats = await lstat(rootPath, { bigint: true });
        if (stats.isSymbolicLink() || !stats.isDirectory())
            throw new CaxriError('PATH_DENIED', 'Workbench root changed during authorization');
        await this.options.beforeRootIdentityRealpath?.();
        const canonical = await realpath(rootPath);
        const currentStats = await lstat(rootPath, { bigint: true });
        if (
            canonical !== rootPath ||
            currentStats.isSymbolicLink() ||
            !currentStats.isDirectory() ||
            currentStats.dev !== stats.dev ||
            currentStats.ino !== stats.ino
        )
            throw new CaxriError('PATH_DENIED', 'Workbench root changed during authorization');
        return { device: stats.dev.toString(), inode: stats.ino.toString() };
    }

    private requireSession(sessionId: string): SessionRecord {
        const session = this.options.database.getSession(sessionId);
        if (!session) throw new CaxriError('NOT_FOUND', 'Session not found');
        return session;
    }

    private requireProject(projectId: string) {
        const project = this.options.database.getProject(projectId);
        if (!project) throw new CaxriError('NOT_FOUND', 'Project not found');
        return project;
    }

    private requireCandidate(sessionId: string, candidateId: string): WorkbenchCandidate {
        const candidate = this.candidates.get(candidateId);
        if (!candidate || candidate.sessionId !== sessionId)
            throw new CaxriError('NOT_FOUND', 'Workbench candidate is no longer available');
        return candidate;
    }

    private rememberObservedAgentCwd(terminalId: string, agentCwd: string): void {
        this.observedAgentCwds.delete(terminalId);
        this.observedAgentCwds.set(terminalId, agentCwd);
        while (this.observedAgentCwds.size > MAX_OBSERVED_AGENT_CWDS) {
            const oldest = this.observedAgentCwds.keys().next().value;
            if (!oldest) break;
            this.observedAgentCwds.delete(oldest);
        }
    }

    private isCurrentObservation(terminalId: string, reported: string): boolean {
        return this.observedAgentCwds.get(terminalId) === reported;
    }

    /**
     * Treats the reported directory as an unproven claim throughout: it becomes durable only after canonicalization and
     * a forced topology read agree that it is a linked worktree root of the owning Project's repository.
     */
    private async reconcileAgentCwd(signal: AgentLifecycleSignal, reported: string): Promise<void> {
        const terminal = this.options.database.getTerminal(signal.terminalId);
        if (!terminal?.provider || terminal.provider !== signal.provider) return;
        const session = this.options.database.getSession(terminal.sessionId);
        if (!session) return;
        const owner = this.options.database.getProject(session.projectId);
        if (!owner) return;
        const initiatingBinding = this.options.database.getSessionWorkbenchBinding(session.id);
        let canonical: string;
        try {
            canonical = await realpath(reported);
        } catch {
            return;
        }
        /**
         * The Agent returned to the Terminal's launch root (Claude Code's `ExitWorktree`, or a plain restart). Drop the
         * divergence so provider state resolves against the launch root again.
         */
        if (canonical === terminal.cwd) {
            if (!this.isCurrentObservation(signal.terminalId, reported)) return;
            updateObservedAgentCwd(this.options, terminal, undefined);
            return;
        }
        const topology = await this.loadTopology(owner.rootPath);
        if (topology.worktrees.every((worktree) => worktree.rootPath !== canonical)) return;
        const current = this.options.database.getTerminal(signal.terminalId);
        const currentSession = this.options.database.getSession(terminal.sessionId);
        if (
            !currentSession ||
            !current?.provider ||
            current.provider !== signal.provider ||
            current.sessionId !== terminal.sessionId ||
            current.cwd !== terminal.cwd ||
            currentSession.projectId !== session.projectId ||
            !this.isCurrentObservation(signal.terminalId, reported)
        )
            return;
        updateObservedAgentCwd(this.options, current, canonical);
        await this.followWorktree(
            {
                repositoryKey: topology.repositoryKey,
                rootPath: canonical,
                sessionId: currentSession.id,
            },
            () =>
                this.isCurrentObservation(signal.terminalId, reported) &&
                isSameWorkbenchBinding(
                    initiatingBinding,
                    this.options.database.getSessionWorkbenchBinding(session.id),
                ),
        );
    }

    /**
     * Automatic following is standing user authorization for proven Session worktrees, not arbitrary reported paths.
     * Recheck policy, provenance, binding, topology and identity before the synchronous registration/selection commit
     * so a changed setting, retired Agent or manual root selection cannot leave an unintended durable root grant.
     */
    private async followWorktree(
        input: { repositoryKey: string; rootPath: string; sessionId: string },
        isStillAuthorized: () => boolean,
    ): Promise<void> {
        const behavior = this.options.behavior();
        if (behavior === 'ignore' || !isStillAuthorized()) return;
        const authorized = this.options.database.findProjectByRootPath(input.rootPath);
        if (
            behavior !== 'continueAutomatically' &&
            !(authorized && behavior === 'continueWhenAuthorized')
        ) {
            this.addCandidate(input);
            return;
        }
        const startedAt = performance.now();
        const binding = this.options.database.getSessionWorkbenchBinding(input.sessionId);
        if (!binding || (authorized && binding.workbenchProjectId === authorized.id)) return;
        const owner = this.requireProject(binding.projectId);
        const topology = await this.loadTopology(owner.rootPath);
        if (
            topology.repositoryKey !== input.repositoryKey ||
            topology.worktrees.every((worktree) => worktree.rootPath !== input.rootPath)
        )
            return;
        const identity = await this.rootIdentity(input.rootPath);
        if (
            this.options.behavior() !== behavior ||
            !isStillAuthorized() ||
            !isSameWorkbenchBinding(
                binding,
                this.options.database.getSessionWorkbenchBinding(input.sessionId),
            )
        )
            return;
        const project = authorized ?? this.options.database.createProject(input.rootPath, owner.id);
        this.commitSelection(
            input.sessionId,
            project.id,
            authorized ? 'selected' : 'authorized',
            identity,
            startedAt,
            'agent',
        );
    }

    /**
     * `origin` is not a second spelling of `reason`; see `workbench.changed` in `@caxri/protocol` for why.
     */
    private commitSelection(
        sessionId: string,
        projectId: string,
        reason: 'selected' | 'authorized',
        identity: { device: string; inode: string } | undefined,
        startedAt: number,
        origin: 'user' | 'agent',
    ): SessionRecord {
        const selected = this.options.database.selectWorkbenchProject(
            sessionId,
            projectId,
            identity,
        );
        this.publishChange(selected, origin === 'agent' ? 'followed' : reason);
        this.options.logger.write('info', workbenchRootLogEvents.selected, {
            durationMs: performance.now() - startedAt,
            fields: { reason, origin, sessionId, projectId, policy: this.options.behavior() },
        });
        return selected;
    }

    setRootChangedHandler(handler: (sessionId: string) => void): void {
        this.onRootChanged = handler;
    }

    /**
     * Captures the owning repository before the prepared Agent generation can spawn and create a worktree. A failed
     * structured Git read leaves no baseline without blocking launch. A current creation hook may retry within its
     * bounded PreToolUse budget; attribution still requires that exact command's before-snapshot.
     */
    async primeAgentLaunch(scope: WorktreeProvenanceScope): Promise<boolean> {
        return this.worktreeAttribution.prime(scope);
    }

    retireTerminal(terminalId: string): void {
        this.observedAgentCwds.delete(terminalId);
        this.worktreeAttribution.retireTerminal(terminalId);
    }

    /**
     * Reconciles the directory the Agent says it is in against the owning Project's real worktree topology, then makes
     * the proven result durable.
     *
     * The paired-snapshot `git worktree add` attribution cannot see this transition at all: Claude Code's
     * `EnterWorktree` is not a shell command, and its `path` mode enters a worktree that already exists, so no
     * before/after topology delta occurs. Because the reported directory arrives on every phase, this path is
     * independent of which tool performed the move.
     *
     * @see https://github.com/tjx666/caxri/issues/575
     */
    observeAgentCwd(signal: AgentLifecycleSignal): void {
        const reported = signal.agentCwd;
        if (!reported) return;
        if (this.observedAgentCwds.get(signal.terminalId) === reported) return;
        /**
         * Remember before validating. A reported directory that fails Git validation must not re-enter the queue on
         * every subsequent hook event of the same launch.
         */
        this.rememberObservedAgentCwd(signal.terminalId, reported);
        // The hook callback is synchronous; `runQueued` already logs the failure, and a lost reconciliation is retried
        // by the next divergent report.
        // eslint-disable-next-line no-void -- the reconciliation owns and contains its asynchronous failure
        void this.runQueued(() => this.reconcileAgentCwd(signal, reported)).catch(() => {});
    }

    async observeShellToolStarted(
        signal: AgentLifecycleSignal,
        isCurrentLaunch: () => boolean,
    ): Promise<AgentSignalDecision> {
        return this.worktreeAttribution.observeStarted(signal, isCurrentLaunch);
    }

    /**
     * Revalidates deletion after every successful Bash tool and attributes creation only when this outcome pairs with
     * the exact classified PreToolUse snapshot. The hook never reports a path or result content.
     */
    observeShellToolFinished(signal: AgentLifecycleSignal): AgentSignalDecision {
        const attributed = this.worktreeAttribution.observeFinished(signal);
        if (attributed !== 'accepted') return attributed;
        const terminal = this.options.database.getTerminal(signal.terminalId);
        if (!terminal) return 'terminalMissing';
        const session = this.options.database.getSession(terminal.sessionId);
        if (!session) return 'sessionMissing';
        if (session.workbenchProjectId !== session.projectId)
            this.deletionValidations.schedule(session.id);
        return 'accepted';
    }

    observeShellToolFailed(signal: AgentLifecycleSignal): AgentSignalDecision {
        return this.worktreeAttribution.observeFailed(signal);
    }

    async listOptions(sessionId: string): Promise<WorkbenchRootOption[]> {
        const session = this.requireSession(sessionId);
        const owner = this.requireProject(session.projectId);
        let topology: GitWorktreeTopology | undefined;
        try {
            topology = await this.loadTopology(owner.rootPath);
        } catch {
            const active = this.options.database.getProject(session.workbenchProjectId);
            return unavailableWorkbenchRoots(owner, active);
        }
        const options = await discoverWorkbenchRoots(
            topology,
            this.options.database.listProjects(),
            owner.id,
            sessionId,
        );
        if (options.every((option) => option.projectId !== owner.id))
            options.unshift(unavailableWorkbenchRoot(owner, owner.id));
        const ranked = await withConversationRanks(session, options, this.options.sessionContext);
        return ranked.toSorted((left, right) => Number(right.owner) - Number(left.owner));
    }

    /**
     * Every caller is an explicit picker, candidate-prompt, or confirmed Main request, so the origin is the user.
     */
    async select(
        sessionId: string,
        projectId: string,
        reason: 'selected' | 'authorized' = 'selected',
        isStillAuthorized: () => boolean = () => true,
    ): Promise<SessionRecord> {
        const startedAt = performance.now();
        const session = this.requireSession(sessionId);
        const project = this.requireProject(projectId);
        let identity: { device: string; inode: string } | undefined;
        if (project.id !== session.projectId) {
            const owner = this.requireProject(session.projectId);
            const topology = await this.loadTopology(owner.rootPath);
            if (topology.worktrees.every((worktree) => worktree.rootPath !== project.rootPath))
                throw new CaxriError(
                    'PATH_DENIED',
                    'Workbench Project is not a linked worktree of the owning Project',
                );
            identity = await this.rootIdentity(project.rootPath);
        }
        if (!isStillAuthorized())
            throw new CaxriError('UNAVAILABLE', 'Workbench selection authority expired');
        return this.commitSelection(sessionId, projectId, reason, identity, startedAt, 'user');
    }

    /**
     * A suggestion can remain visible while its Session is in the background. Elapsed time must not invalidate the
     * user's eventual choice; authorization revalidates the root and current Git topology before selecting it.
     */
    claimCandidate(
        sessionId: string,
        candidateId: string,
    ): { candidateId: string; rootPath: string; projectId?: string } {
        const candidate = this.requireCandidate(sessionId, candidateId);
        if (candidate.state !== 'pending')
            throw new CaxriError('CONFLICT', 'Workbench candidate was already handled');
        candidate.state = 'claimed';
        const project = this.options.database.findProjectByRootPath(candidate.rootPath);
        return {
            candidateId,
            rootPath: candidate.rootPath,
            ...(project && { projectId: project.id }),
        };
    }

    dismissCandidate(sessionId: string, candidateId: string): void {
        this.requireCandidate(sessionId, candidateId);
        this.candidates.delete(candidateId);
    }

    /**
     * Removes the trashed path's editor tabs from every Session's stored snapshot of one Workbench Root.
     *
     * The Renderer can only close tabs for the root each Session is currently showing, so without this a Session parked
     * elsewhere keeps a tab for a file that no longer exists and reopens it stuck on `Loading file…` (issue #909).
     *
     * Containment is checked against the named root rather than the Session's current one, because a Trash is always
     * authorized against the root the confirmation was about, which the Session may have left since. Requiring the root
     * to be the Session's owner or its active root keeps a Renderer from naming an unrelated Project's stored layout.
     */
    forgetEditorPath(sessionId: string, workbenchProjectId: string, path: string): void {
        const session = this.requireSession(sessionId);
        if (
            workbenchProjectId !== session.projectId &&
            workbenchProjectId !== session.workbenchProjectId
        )
            throw new CaxriError('PATH_DENIED', 'Workbench Root is not selected by this Session');
        /**
         * `pathSchema` only bounds the length, and `relative()` resolves a relative argument against the Server's own
         * cwd, so an absolute path is required before containment means anything. The root itself is refused for the
         * same reason `files.trash` refuses it (`files/mutations.ts`): it can never be trashed, and accepting it here
         * would let one call clear every stored document tab of the root.
         */
        if (!isAbsolute(path)) throw new CaxriError('VALIDATION', 'Trashed path must be absolute');
        const nested = relative(this.requireProject(workbenchProjectId).rootPath, path);
        if (nested === '')
            throw new CaxriError('PATH_DENIED', 'The Workbench Root itself cannot be trashed');
        assertInsideRoot(nested, 'Trashed path is outside the Workbench Root');
        this.options.database.removeWorkbenchEditorPath(workbenchProjectId, path);
    }

    /**
     * Main cleanup is idempotent because successful authorization consumes the candidate first.
     */
    cancelCandidate(sessionId: string, candidateId: string): void {
        const candidate = this.candidates.get(candidateId);
        if (candidate?.sessionId === sessionId) this.candidates.delete(candidateId);
    }

    async authorizeCandidate(
        sessionId: string,
        candidateId: string,
        rootPath: string,
    ): Promise<SessionRecord> {
        const candidate = this.requireCandidate(sessionId, candidateId);
        try {
            if (candidate.state !== 'claimed')
                throw new CaxriError('CONFLICT', 'Workbench candidate was not claimed');
            const canonical = await realpath(rootPath);
            if (canonical !== candidate.rootPath)
                throw new CaxriError('PATH_DENIED', 'Selected folder does not match the worktree');
            const session = this.requireSession(sessionId);
            const owner = this.requireProject(session.projectId);
            const topology = await this.loadTopology(owner.rootPath);
            if (
                topology.repositoryKey !== candidate.repositoryKey ||
                topology.worktrees.every((worktree) => worktree.rootPath !== canonical)
            )
                throw new CaxriError('CONFLICT', 'The worktree candidate is no longer available');
            await this.rootIdentity(canonical);
            // Auto-registration: the worktree becomes a fully authorized Project owned by this Session's Project, so
            // the PrimarySidebar keeps showing one top-level entry per checkout the user actually added.
            const project = this.options.database.createProject(canonical, owner.id);
            return await this.select(sessionId, project.id, 'authorized');
        } finally {
            this.candidates.delete(candidateId);
        }
    }

    /**
     * Resolves only a currently discoverable, identity-bound worktree within this Session's repository.
     */
    async resolveWorktree(sessionId: string, worktreeId: string): Promise<string> {
        const roots = await this.listOptions(sessionId);
        const root = roots.find((option) => option.worktreeId === worktreeId);
        if (!root)
            throw new CaxriError(
                'NOT_FOUND',
                'The worktree is no longer available. Reopen the picker.',
            );
        return root.rootPath;
    }

    /**
     * Main supplies the identity-bound ID after explicit confirmation. Direct internal callers already hold a root
     * grant.
     */
    async authorizeSelection(
        sessionId: string,
        rootPath: string,
        worktreeId?: string,
    ): Promise<SessionRecord> {
        const startedAt = performance.now();
        const canonical = await realpath(rootPath);
        if (canonical !== rootPath)
            throw new CaxriError('PATH_DENIED', 'Selected Workbench Root is not canonical');
        const session = this.requireSession(sessionId);
        const owner = this.requireProject(session.projectId);
        const topology = await this.loadTopology(owner.rootPath);
        if (topology.worktrees.every((worktree) => worktree.rootPath !== canonical))
            throw new CaxriError(
                'PATH_DENIED',
                'Selected folder is not a linked worktree of the owning Project',
            );
        const identity = await this.rootIdentity(canonical);
        if (
            worktreeId &&
            worktreeIdentityId(topology.repositoryKey, canonical, identity, sessionId) !==
                worktreeId
        )
            throw new CaxriError('CONFLICT', 'The worktree changed. Reopen the picker.');
        // No asynchronous gap after registration: failed post-registration validation must not leave a root grant.
        this.requireSession(sessionId);
        const project = this.options.database.createProject(canonical, owner.id);
        return this.commitSelection(
            sessionId,
            project.id,
            'authorized',
            project.id === owner.id ? undefined : identity,
            startedAt,
            'user',
        );
    }

    async validateSession(sessionId: string): Promise<boolean> {
        const binding = this.options.database.getSessionWorkbenchBinding(sessionId);
        if (!binding || binding.workbenchProjectId === binding.projectId) return false;
        return this.validateBinding(sessionId, binding);
    }

    async validate(sessionId?: string): Promise<void> {
        if (sessionId) {
            await this.validateSession(this.requireSession(sessionId).id);
            return;
        }
        const sweeping = sweepWorkbenchRoots({
            database: this.options.database,
            isClosed: () => this.closed,
            loadTopology: (ownerRoot) => this.loadTopology(ownerRoot),
            logger: this.options.logger,
            validateBinding: (sessionId, binding, topology, timer) =>
                this.validateBinding(sessionId, binding, topology, timer),
        });
        this.sweeps.add(sweeping);
        try {
            await sweeping;
        } finally {
            this.sweeps.delete(sweeping);
        }
    }

    projectDeleted(affectedSessionIds: readonly string[]): void {
        for (const sessionId of affectedSessionIds) {
            const session = this.options.database.getSession(sessionId);
            if (session) this.publishChange(session, 'fallback', 'project_deleted');
        }
    }

    /**
     * Stops new background work and waits for any topology read or all-Session sweep that already crossed the boundary.
     */
    async close(): Promise<void> {
        this.closed = true;
        this.worktreeAttribution.close();
        this.deletionValidations.close();
        this.candidates.clear();
        this.observedAgentCwds.clear();
        await this.queue;
        await Promise.allSettled(this.sweeps);
    }
}
