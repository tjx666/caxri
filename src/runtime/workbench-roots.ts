import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';

import type {
    AgentEndpointRef as AgentEndpointReference,
    AgentEndpointSummary,
    AgentProvider,
    AgentWorktreeCreatedResult,
    NewWorktreeBehavior,
    RuntimeEvent,
    SessionRecord,
    WorkbenchRootOption,
} from '@caxri/protocol';
import { CaxriError, errorMessage } from '@caxri/protocol';

import type { StructuredLogger } from '../shared/node/logger';
import { logEventCatalog } from '../shared/node/logger';
import type { AgentLifecycleSignal } from './agents';
import type { CaxriDatabase } from './db';
import type { RuntimeHandlers } from './dispatch';
import type { GitService, GitWorktreeTopology } from './git';
import { SingleFlight } from './single-flight';
import { BoundedSerialBatcher } from './workbench-provenance';

const CANDIDATE_TTL_MS = 10 * 60_000;
const MAX_CANDIDATES = 256;
const MAX_PENDING_DELETION_VALIDATIONS = 256;
const MAX_PROVENANCE_BASELINES = 256;
const SHELL_VALIDATION_SETTLE_MS = 100;
const workbenchRootLogEvents = logEventCatalog.workbenchRoot;

interface WorkbenchCandidate {
    candidateId: string;
    createdAt: number;
    repositoryKey: string;
    rootPath: string;
    sessionId: string;
    state: 'pending' | 'claimed';
}

interface WorktreeProvenanceScope {
    projectId: string;
    provider: AgentProvider;
    ref: AgentEndpointReference;
    sessionId: string;
    terminalId: string;
}

interface WorktreeProvenanceBaseline extends WorktreeProvenanceScope {
    reportedPaths: ReadonlySet<string>;
    repositoryKey: string;
    rootPaths: ReadonlySet<string>;
}

type TopologyValidation =
    { status: 'available'; topology: GitWorktreeTopology } | { status: 'unavailable' };

interface WorkbenchRootServiceOptions {
    /**
     * Integration-test seam for replacing a root between its identity read and canonicalization.
     */
    beforeRootIdentityRealpath?: () => Promise<void>;
    behavior(): NewWorktreeBehavior;
    database: CaxriDatabase;
    emit(event: RuntimeEvent): void;
    git: GitService;
    logger: StructuredLogger;
}

function endpointKey(reference: AgentEndpointReference): string {
    return JSON.stringify([reference.hostId, reference.endpointId, reference.generation]);
}

function isSameWorkbenchBinding(
    left: ReturnType<CaxriDatabase['getSessionWorkbenchBinding']>,
    right: ReturnType<CaxriDatabase['getSessionWorkbenchBinding']>,
): boolean {
    return (
        left?.projectId === right?.projectId &&
        left?.workbenchProjectId === right?.workbenchProjectId &&
        left?.rootDevice === right?.rootDevice &&
        left?.rootInode === right?.rootInode
    );
}

/**
 * Owns the only bridge from authenticated Agent Endpoint provenance to authoritative Git worktree topology. A
 * discovered path remains inert until the exact Endpoint generation reports it and the pre-launch baseline proves it is
 * new in the owning repository.
 */
export class WorkbenchRootService {
    private readonly candidates = new Map<string, WorkbenchCandidate>();
    private readonly deletionValidations: BoundedSerialBatcher<string>;
    private readonly provenanceBaselines = new Map<string, WorktreeProvenanceBaseline>();
    private readonly topologyReads = new SingleFlight<string, GitWorktreeTopology>();
    private closed = false;
    private queue: Promise<void> = Promise.resolve();
    private onRootChanged?: (sessionId: string) => void;

    constructor(private readonly options: WorkbenchRootServiceOptions) {
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
    ): Promise<boolean> {
        const owner = this.options.database.getProject(binding.projectId);
        const active = this.options.database.getProject(binding.workbenchProjectId);
        let reason = 'valid';
        try {
            if (!owner || !active) reason = 'project_missing';
            else {
                const topology = topologyValidation
                    ? topologyValidation.status === 'available'
                        ? topologyValidation.topology
                        : undefined
                    : await this.loadTopology(owner.rootPath);
                if (!topology) throw new Error('Workbench topology is unavailable');
                if (topology.worktrees.every((worktree) => worktree.rootPath !== active.rootPath)) {
                    this.forgetReportedPath(topology.repositoryKey, active.rootPath);
                    reason = 'topology_removed';
                } else {
                    const identity = await this.rootIdentity(active.rootPath);
                    if (
                        identity.device !== binding.rootDevice ||
                        identity.inode !== binding.rootInode
                    )
                        reason = 'root_replaced';
                }
            }
        } catch {
            reason = 'root_unavailable';
        }
        if (reason === 'valid') return false;
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
        this.fallback(sessionId, reason);
        return true;
    }

    /**
     * Reassigns the queue synchronously so baseline and report operations cannot both consume the same pre-report
     * topology. The returned task retains its own failure while the durable queue logs and continues.
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

    private rememberBaseline(baseline: WorktreeProvenanceBaseline): void {
        const key = endpointKey(baseline.ref);
        this.provenanceBaselines.delete(key);
        this.provenanceBaselines.set(key, baseline);
        while (this.provenanceBaselines.size > MAX_PROVENANCE_BASELINES) {
            const oldest = this.provenanceBaselines.keys().next().value;
            if (!oldest) break;
            this.provenanceBaselines.delete(oldest);
        }
    }

    private forgetReportedPath(repoKey: string, rootPath: string): void {
        for (const [key, baseline] of this.provenanceBaselines)
            if (baseline.repositoryKey === repoKey && baseline.reportedPaths.has(rootPath)) {
                const reportedPaths = new Set(baseline.reportedPaths);
                reportedPaths.delete(rootPath);
                this.provenanceBaselines.set(key, { ...baseline, reportedPaths });
            }
    }

    private addCandidate(input: {
        repositoryKey: string;
        rootPath: string;
        sessionId: string;
    }): void {
        this.pruneCandidates();
        for (const [candidateId, candidate] of this.candidates)
            if (candidate.sessionId === input.sessionId) this.candidates.delete(candidateId);
        while (this.candidates.size >= MAX_CANDIDATES) {
            const oldest = this.candidates.keys().next().value;
            if (!oldest) break;
            this.candidates.delete(oldest);
        }
        const candidateId = randomUUID();
        this.candidates.set(candidateId, {
            ...input,
            candidateId,
            createdAt: Date.now(),
            state: 'pending',
        });
        this.options.emit({
            event: 'workbench.candidate',
            payload: { candidateId, sessionId: input.sessionId },
        });
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
        reason: 'selected' | 'authorized' | 'fallback',
        fallbackReason?: string,
    ): void {
        const owner = this.requireProject(session.projectId);
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
        if (candidate.createdAt + CANDIDATE_TTL_MS <= Date.now()) {
            this.candidates.delete(candidateId);
            throw new CaxriError('CONFLICT', 'Workbench candidate expired');
        }
        return candidate;
    }

    private pruneCandidates(): void {
        const cutoff = Date.now() - CANDIDATE_TTL_MS;
        for (const [candidateId, candidate] of this.candidates)
            if (candidate.createdAt <= cutoff) this.candidates.delete(candidateId);
    }

    setRootChangedHandler(handler: (sessionId: string) => void): void {
        this.onRootChanged = handler;
    }

    /**
     * Captures the owning repository before the prepared Agent generation can spawn and create a worktree. A failed
     * structured Git read leaves no baseline, so later reports fail closed without blocking the Agent launch.
     */
    async primeAgentEndpoint(scope: WorktreeProvenanceScope): Promise<boolean> {
        return this.runQueued(async () => {
            this.retireTerminal(scope.terminalId);
            const terminal = this.options.database.getTerminal(scope.terminalId);
            const session = this.options.database.getSession(scope.sessionId);
            const owner = this.options.database.getProject(scope.projectId);
            if (
                !terminal ||
                !session ||
                !owner ||
                terminal.sessionId !== scope.sessionId ||
                terminal.provider !== scope.provider ||
                session.projectId !== scope.projectId
            )
                return false;
            const startedAt = performance.now();
            try {
                const topology = await this.loadTopology(owner.rootPath);
                const currentTerminal = this.options.database.getTerminal(scope.terminalId);
                const currentSession = this.options.database.getSession(scope.sessionId);
                if (
                    !currentTerminal ||
                    !currentSession ||
                    currentTerminal.sessionId !== scope.sessionId ||
                    currentTerminal.provider !== scope.provider ||
                    currentSession.projectId !== scope.projectId
                )
                    return false;
                this.rememberBaseline({
                    ...scope,
                    reportedPaths: new Set(),
                    repositoryKey: topology.repositoryKey,
                    rootPaths: new Set(topology.worktrees.map(({ rootPath }) => rootPath)),
                });
                this.options.logger.write('debug', workbenchRootLogEvents.provenancePrimed, {
                    durationMs: performance.now() - startedAt,
                    fields: {
                        generation: scope.ref.generation,
                        terminalId: scope.terminalId,
                        worktreeCount: topology.worktrees.length,
                    },
                });
                return true;
            } catch (error) {
                this.options.logger.write('debug', workbenchRootLogEvents.provenanceUnavailable, {
                    durationMs: performance.now() - startedAt,
                    fields: {
                        error: errorMessage(error, 'unknown'),
                        terminalId: scope.terminalId,
                    },
                });
                return false;
            }
        });
    }

    /**
     * Accepts one exact path only when the authenticated generation, pre-launch baseline, live database scope, and a
     * forced structured Git topology read all agree. No repository delta or Agent-running signal can enter this path.
     */
    async reportCreatedWorktree(
        endpoint: AgentEndpointSummary,
        rootPath: string,
        isCurrentEndpoint: () => boolean,
    ): Promise<AgentWorktreeCreatedResult> {
        return this.runQueued(async () => {
            if (!isCurrentEndpoint()) return { status: 'ignored', reason: 'endpoint_unavailable' };
            const key = endpointKey(endpoint.ref);
            const baseline = this.provenanceBaselines.get(key);
            if (!baseline) return { status: 'ignored', reason: 'baseline_missing' };
            if (
                baseline.projectId !== endpoint.projectId ||
                baseline.provider !== endpoint.provider ||
                baseline.sessionId !== endpoint.sessionId ||
                baseline.terminalId !== endpoint.terminalId
            )
                return { status: 'ignored', reason: 'scope_mismatch' };
            const terminal = this.options.database.getTerminal(endpoint.terminalId);
            const session = this.options.database.getSession(endpoint.sessionId);
            const owner = this.options.database.getProject(endpoint.projectId);
            if (
                !terminal ||
                !session ||
                !owner ||
                terminal.sessionId !== endpoint.sessionId ||
                terminal.provider !== endpoint.provider ||
                session.projectId !== endpoint.projectId
            )
                return { status: 'ignored', reason: 'scope_mismatch' };
            let canonical: string;
            try {
                canonical = await realpath(rootPath);
            } catch {
                return { status: 'ignored', reason: 'path_not_canonical' };
            }
            if (canonical !== rootPath) return { status: 'ignored', reason: 'path_not_canonical' };
            if (baseline.rootPaths.has(canonical) || baseline.reportedPaths.has(canonical))
                return { status: 'ignored', reason: 'path_preexisting' };
            let topology: GitWorktreeTopology;
            try {
                topology = await this.loadTopology(owner.rootPath);
            } catch {
                return { status: 'ignored', reason: 'topology_unavailable' };
            }
            if (!isCurrentEndpoint()) return { status: 'ignored', reason: 'endpoint_unavailable' };
            if (this.provenanceBaselines.get(key) !== baseline)
                return { status: 'ignored', reason: 'baseline_missing' };
            const currentTerminal = this.options.database.getTerminal(endpoint.terminalId);
            const currentSession = this.options.database.getSession(endpoint.sessionId);
            if (
                !currentTerminal ||
                !currentSession ||
                currentTerminal.sessionId !== endpoint.sessionId ||
                currentTerminal.provider !== endpoint.provider ||
                currentSession.projectId !== endpoint.projectId
            )
                return { status: 'ignored', reason: 'scope_mismatch' };
            if (topology.repositoryKey !== baseline.repositoryKey)
                return { status: 'ignored', reason: 'repository_mismatch' };
            if (
                topology.worktrees.filter((worktree) => worktree.rootPath === canonical).length !==
                1
            )
                return { status: 'ignored', reason: 'path_not_linked' };
            this.rememberBaseline({
                ...baseline,
                reportedPaths: new Set([...baseline.reportedPaths, canonical]),
            });
            if (this.options.behavior() === 'ignore')
                return { status: 'ignored', reason: 'behavior_ignored' };
            const authorized = this.options.database.findProjectByRootPath(canonical);
            if (authorized && this.options.behavior() === 'continueWhenAuthorized') {
                try {
                    await this.select(
                        endpoint.sessionId,
                        authorized.id,
                        'selected',
                        isCurrentEndpoint,
                    );
                    return { status: 'accepted', action: 'selected' };
                } catch {
                    return {
                        status: 'ignored',
                        reason: isCurrentEndpoint()
                            ? 'topology_unavailable'
                            : 'endpoint_unavailable',
                    };
                }
            }
            this.addCandidate({
                repositoryKey: topology.repositoryKey,
                rootPath: canonical,
                sessionId: endpoint.sessionId,
            });
            return { status: 'accepted', action: 'candidate' };
        });
    }

    retireTerminal(terminalId: string): void {
        for (const [key, baseline] of this.provenanceBaselines)
            if (baseline.terminalId === terminalId) this.provenanceBaselines.delete(key);
    }

    /**
     * Revalidates only a previously selected non-owner root. This content-free timing boundary can return a Session to
     * its owner after deletion, but it never records a baseline, discovers an addition, or emits a candidate.
     */
    observeShellToolFinished(signal: AgentLifecycleSignal): boolean {
        const terminal = this.options.database.getTerminal(signal.terminalId);
        if (!terminal || terminal.provider !== signal.provider) return false;
        const session = this.options.database.getSession(terminal.sessionId);
        if (!session) return false;
        if (session.workbenchProjectId === session.projectId) return true;
        return this.deletionValidations.schedule(session.id);
    }

    async listOptions(sessionId: string): Promise<WorkbenchRootOption[]> {
        const session = this.requireSession(sessionId);
        const owner = this.requireProject(session.projectId);
        let topology: GitWorktreeTopology | undefined;
        try {
            topology = await this.loadTopology(owner.rootPath);
        } catch {
            const active = this.options.database.getProject(session.workbenchProjectId);
            return [owner, ...(active && active.id !== owner.id ? [active] : [])].map(
                (project) => ({
                    projectId: project.id,
                    displayTitle: project.displayTitle,
                    branch: 'No branch',
                    owner: project.id === owner.id,
                }),
            );
        }
        const projectsByRoot = new Map(
            this.options.database.listProjects().map((project) => [project.rootPath, project]),
        );
        const options = topology.worktrees.flatMap((worktree) => {
            const project = projectsByRoot.get(worktree.rootPath);
            return project
                ? [
                      {
                          projectId: project.id,
                          displayTitle: project.displayTitle,
                          branch: worktree.branch,
                          owner: project.id === owner.id,
                      },
                  ]
                : [];
        });
        if (options.every((option) => option.projectId !== owner.id))
            options.unshift({
                projectId: owner.id,
                displayTitle: owner.displayTitle,
                branch: 'No branch',
                owner: true,
            });
        return options.toSorted((left, right) => Number(right.owner) - Number(left.owner));
    }

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
        const selected = this.options.database.selectWorkbenchProject(
            sessionId,
            projectId,
            identity,
        );
        this.publishChange(selected, reason);
        this.options.logger.write('info', workbenchRootLogEvents.selected, {
            durationMs: performance.now() - startedAt,
            fields: { reason, sessionId, projectId },
        });
        return selected;
    }

    claimCandidate(
        sessionId: string,
        candidateId: string,
    ): { candidateId: string; rootPath: string; projectId?: string } {
        this.pruneCandidates();
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
                throw new CaxriError(
                    'PATH_DENIED',
                    'Selected directory does not match the worktree',
                );
            const session = this.requireSession(sessionId);
            const owner = this.requireProject(session.projectId);
            const topology = await this.loadTopology(owner.rootPath);
            if (
                topology.repositoryKey !== candidate.repositoryKey ||
                topology.worktrees.every((worktree) => worktree.rootPath !== canonical)
            )
                throw new CaxriError('CONFLICT', 'The worktree candidate is no longer available');
            await this.rootIdentity(canonical);
            const project = this.options.database.createProject(canonical);
            return await this.select(sessionId, project.id, 'authorized');
        } finally {
            this.candidates.delete(candidateId);
        }
    }

    /**
     * Authorizes a user-selected linked worktree even when provider hooks are unavailable.
     */
    async authorizeSelection(sessionId: string, rootPath: string): Promise<SessionRecord> {
        const canonical = await realpath(rootPath);
        if (canonical !== rootPath)
            throw new CaxriError('PATH_DENIED', 'Selected Workbench Root is not canonical');
        const session = this.requireSession(sessionId);
        const owner = this.requireProject(session.projectId);
        const topology = await this.loadTopology(owner.rootPath);
        if (topology.worktrees.every((worktree) => worktree.rootPath !== canonical))
            throw new CaxriError(
                'PATH_DENIED',
                'Selected directory is not a linked worktree of the owning Project',
            );
        await this.rootIdentity(canonical);
        const project = this.options.database.createProject(canonical);
        return this.select(sessionId, project.id, 'authorized');
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
        const groups = new Map<
            string,
            Array<{
                binding: NonNullable<ReturnType<CaxriDatabase['getSessionWorkbenchBinding']>>;
                sessionId: string;
            }>
        >();
        for (const session of this.options.database.listSessions()) {
            const binding = this.options.database.getSessionWorkbenchBinding(session.id);
            if (!binding || binding.workbenchProjectId === binding.projectId) continue;
            const entries = groups.get(binding.projectId) ?? [];
            entries.push({ binding, sessionId: session.id });
            groups.set(binding.projectId, entries);
        }
        /**
         * This sweep gates Workbench Root filesystem authorization, so it deliberately stays sequential: an unexpected
         * throw must stop the remaining validations instead of letting concurrently dispatched entries finish mutating
         * Session bindings after the failure.
         */
        for (const [ownerProjectId, entries] of groups) {
            const owner = this.options.database.getProject(ownerProjectId);
            let topologyValidation: TopologyValidation = { status: 'unavailable' };
            if (owner)
                try {
                    topologyValidation = {
                        status: 'available',
                        // eslint-disable-next-line no-await-in-loop -- fail-fast ordering, see above
                        topology: await this.loadTopology(owner.rootPath),
                    };
                } catch {
                    // Every Session in this owner group receives the same fail-closed result.
                }
            for (const entry of entries) {
                // eslint-disable-next-line no-await-in-loop -- fail-fast ordering, see above
                await this.validateBinding(entry.sessionId, entry.binding, topologyValidation);
            }
        }
    }

    projectDeleted(affectedSessionIds: readonly string[]): void {
        for (const sessionId of affectedSessionIds) {
            const session = this.options.database.getSession(sessionId);
            if (session) this.publishChange(session, 'fallback', 'project_deleted');
        }
    }

    /**
     * Stops new background work and waits for any topology read that already crossed the boundary.
     */
    async close(): Promise<void> {
        this.closed = true;
        this.deletionValidations.close();
        this.provenanceBaselines.clear();
        this.candidates.clear();
        await this.queue;
    }
}

type WorkbenchRuntimeHandlers = Pick<
    RuntimeHandlers,
    | 'session.authorizeWorkbenchRoot'
    | 'session.continueInWorktree'
    | 'session.dismissWorkbenchCandidate'
    | 'session.selectWorkbenchRoot'
    | 'session.validateWorkbenchRoots'
    | 'session.workbenchCandidate.authorize'
    | 'session.workbenchCandidate.cancel'
    | 'session.workbenchCandidate.claim'
    | 'session.workbenchRoot.authorizeSelection'
    | 'session.workbenchRoot.reportCreated'
    | 'session.workbenchRoots'
>;

/**
 * Keeps the Workbench Root protocol surface beside its state machine instead of in bootstrap.
 */
export function createWorkbenchRootHandlers(
    service: WorkbenchRootService,
    mainOwned: (method: 'session.authorizeWorkbenchRoot' | 'session.continueInWorktree') => never,
    isCurrentEndpoint: (endpoint: AgentEndpointSummary) => boolean,
): WorkbenchRuntimeHandlers {
    return {
        'session.authorizeWorkbenchRoot': () => mainOwned('session.authorizeWorkbenchRoot'),
        'session.continueInWorktree': () => mainOwned('session.continueInWorktree'),
        'session.workbenchRoots': ({ sessionId }) => service.listOptions(sessionId),
        'session.selectWorkbenchRoot': ({ sessionId, projectId }) =>
            service.select(sessionId, projectId),
        'session.dismissWorkbenchCandidate': ({ sessionId, candidateId }) => {
            service.dismissCandidate(sessionId, candidateId);
            return null;
        },
        'session.workbenchCandidate.claim': ({ sessionId, candidateId }) =>
            service.claimCandidate(sessionId, candidateId),
        'session.workbenchCandidate.authorize': ({ sessionId, candidateId, rootPath }) =>
            service.authorizeCandidate(sessionId, candidateId, rootPath),
        'session.workbenchCandidate.cancel': ({ sessionId, candidateId }) => {
            service.cancelCandidate(sessionId, candidateId);
            return null;
        },
        'session.workbenchRoot.authorizeSelection': ({ sessionId, rootPath }) =>
            service.authorizeSelection(sessionId, rootPath),
        'session.workbenchRoot.reportCreated': ({ endpoint, rootPath }) =>
            service.reportCreatedWorktree(endpoint, rootPath, () => isCurrentEndpoint(endpoint)),
        'session.validateWorkbenchRoots': async ({ sessionId }) => {
            await service.validate(sessionId);
            return null;
        },
    };
}
