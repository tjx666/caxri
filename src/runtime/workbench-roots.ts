import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';

import type { AgentLifecycleSignal } from './agents';
import type { CaxriDatabase } from './db';
import type { RuntimeHandlers } from './dispatch';
import type { GitService, GitWorktreeTopology } from './git';
import { SingleFlight } from './single-flight';
import { CaxriError, errorMessage } from '../shared/ipc/errors';
import type { RuntimeEvent } from '../shared/ipc/events';
import type { StructuredLogger } from '../shared/node/logger';
import type { NewWorktreeBehavior, SessionRecord, WorkbenchRootOption } from '../shared/types';

const SIGNAL_SETTLE_MS = 100;
const CANDIDATE_TTL_MS = 10 * 60_000;
const MAX_PENDING_SIGNALS = 256;
const MAX_CANDIDATES = 256;
const MAX_TOPOLOGY_SNAPSHOTS = 256;
const MAX_STARTUP_TOPOLOGY_PRIMES = 32;

interface WorkbenchCandidate {
    candidateId: string;
    createdAt: number;
    repositoryKey: string;
    rootPath: string;
    sessionId: string;
    state: 'pending' | 'claimed';
}

type TopologyValidation =
    { status: 'available'; topology: GitWorktreeTopology } | { status: 'unavailable' };

interface WorkbenchRootServiceOptions {
    /** Integration-test seam for replacing a root between its identity read and canonicalization. */
    beforeRootIdentityRealpath?: () => Promise<void>;
    behavior(): NewWorktreeBehavior;
    database: CaxriDatabase;
    emit(event: RuntimeEvent): void;
    git: GitService;
    logger: StructuredLogger;
}

function topologyByRoot(topology: GitWorktreeTopology): Map<string, string> {
    return new Map(topology.worktrees.map((worktree) => [worktree.rootPath, worktree.branch]));
}

function topologyFingerprint(topology: ReadonlyMap<string, string>): string {
    return JSON.stringify([...topology].sort(([left], [right]) => left.localeCompare(right)));
}

function sameWorkbenchBinding(
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
 * Owns the only bridge from content-free Agent shell timing to authoritative Git worktree
 * topology. A discovered path remains inert until it matches an independently authorized Project.
 */
export class WorkbenchRootService {
    private readonly candidates = new Map<string, WorkbenchCandidate>();
    private readonly pendingSignals = new Map<string, AgentLifecycleSignal>();
    private readonly topologySnapshots = new Map<string, Map<string, string>>();
    private readonly topologyReads = new SingleFlight<string, GitWorktreeTopology>();
    private closed = false;
    private queue: Promise<void> = Promise.resolve();
    private signalTimer?: NodeJS.Timeout;
    private onRootChanged?: (sessionId: string) => void;

    constructor(private readonly options: WorkbenchRootServiceOptions) {}

    setRootChangedHandler(handler: (sessionId: string) => void): void {
        this.onRootChanged = handler;
    }

    /** Primes topology before an Agent can create its first worktree in a new PTY generation. */
    primeTerminal(terminalId: string): void {
        const terminal = this.options.database.getTerminal(terminalId);
        if (!terminal) return;
        this.enqueue(() => this.primeSessionNow(terminal.sessionId));
    }

    /** Best-effort startup baseline; it never delays Runtime readiness. */
    primeAll(): void {
        const ownerProjectIds = new Set<string>();
        for (const session of this.options.database
            .listSessions()
            .sort((left, right) => right.lastOpenedAt - left.lastOpenedAt)) {
            ownerProjectIds.add(session.projectId);
            if (ownerProjectIds.size >= MAX_STARTUP_TOPOLOGY_PRIMES) break;
        }
        for (const projectId of ownerProjectIds) {
            const project = this.options.database.getProject(projectId);
            if (project) this.enqueue(() => this.primeProjectNow(project.rootPath));
        }
    }

    observeShellToolFinished(signal: AgentLifecycleSignal): boolean {
        const terminal = this.options.database.getTerminal(signal.terminalId);
        if (!terminal || terminal.provider !== signal.provider) return false;
        const session = this.options.database.getSession(terminal.sessionId);
        if (!session) return false;
        if (
            !this.pendingSignals.has(session.id) &&
            this.pendingSignals.size >= MAX_PENDING_SIGNALS
        ) {
            this.options.logger.write('warn', 'workbench_root.signal_dropped', {
                fields: { reason: 'capacity' },
            });
            return false;
        }
        this.pendingSignals.set(session.id, signal);
        if (this.signalTimer) clearTimeout(this.signalTimer);
        this.signalTimer = setTimeout(() => this.flushSignals(), SIGNAL_SETTLE_MS);
        this.signalTimer.unref();
        return true;
    }

    async listOptions(sessionId: string): Promise<WorkbenchRootOption[]> {
        const session = this.requireSession(sessionId);
        const owner = this.requireProject(session.projectId);
        let topology: GitWorktreeTopology | undefined;
        try {
            topology = await this.loadTopology(owner.rootPath);
            this.rememberTopology(topology);
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
        if (!options.some((option) => option.projectId === owner.id))
            options.unshift({
                projectId: owner.id,
                displayTitle: owner.displayTitle,
                branch: 'No branch',
                owner: true,
            });
        return options.sort((left, right) => Number(right.owner) - Number(left.owner));
    }

    async select(
        sessionId: string,
        projectId: string,
        reason: 'selected' | 'authorized' = 'selected',
    ): Promise<SessionRecord> {
        const startedAt = performance.now();
        const session = this.requireSession(sessionId);
        const project = this.requireProject(projectId);
        let identity: { device: string; inode: string } | undefined;
        if (project.id !== session.projectId) {
            const owner = this.requireProject(session.projectId);
            const topology = await this.loadTopology(owner.rootPath);
            this.rememberTopology(topology);
            if (!topology.worktrees.some((worktree) => worktree.rootPath === project.rootPath))
                throw new CaxriError(
                    'PATH_DENIED',
                    'Workbench Project is not a linked worktree of the owning Project',
                );
            identity = await this.rootIdentity(project.rootPath);
        }
        const selected = this.options.database.selectWorkbenchProject(
            sessionId,
            projectId,
            identity,
        );
        this.publishChange(selected, reason);
        this.options.logger.write('info', 'workbench_root.selected', {
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
            ...(project ? { projectId: project.id } : {}),
        };
    }

    dismissCandidate(sessionId: string, candidateId: string): void {
        this.requireCandidate(sessionId, candidateId);
        this.candidates.delete(candidateId);
    }

    /** Main cleanup is idempotent because successful authorization consumes the candidate first. */
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
            this.rememberTopology(topology);
            if (
                topology.repositoryKey !== candidate.repositoryKey ||
                !topology.worktrees.some((worktree) => worktree.rootPath === canonical)
            )
                throw new CaxriError('CONFLICT', 'The worktree candidate is no longer available');
            await this.rootIdentity(canonical);
            const project = this.options.database.createProject(canonical);
            return await this.select(sessionId, project.id, 'authorized');
        } finally {
            this.candidates.delete(candidateId);
        }
    }

    /** Authorizes a user-selected linked worktree even when provider hooks are unavailable. */
    async authorizeSelection(sessionId: string, rootPath: string): Promise<SessionRecord> {
        const canonical = await realpath(rootPath);
        if (canonical !== rootPath)
            throw new CaxriError('PATH_DENIED', 'Selected Workbench Root is not canonical');
        const session = this.requireSession(sessionId);
        const owner = this.requireProject(session.projectId);
        const topology = await this.loadTopology(owner.rootPath);
        this.rememberTopology(topology);
        if (!topology.worktrees.some((worktree) => worktree.rootPath === canonical))
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
                const identity = await this.rootIdentity(active.rootPath);
                if (identity.device !== binding.rootDevice || identity.inode !== binding.rootInode)
                    reason = 'root_replaced';
                else {
                    const topology = topologyValidation
                        ? topologyValidation.status === 'available'
                            ? topologyValidation.topology
                            : undefined
                        : await this.loadTopology(owner.rootPath);
                    if (!topology) throw new Error('Workbench topology is unavailable');
                    if (
                        !topology.worktrees.some(
                            (worktree) => worktree.rootPath === active.rootPath,
                        )
                    )
                        reason = 'topology_removed';
                }
            }
        } catch {
            reason = 'root_unavailable';
        }
        if (reason === 'valid') return false;
        /** Validation crosses filesystem and Git boundaries. A newer selection wins if the
         *  captured binding changed while either asynchronous check was in flight. */
        if (
            !sameWorkbenchBinding(
                binding,
                this.options.database.getSessionWorkbenchBinding(sessionId),
            )
        )
            return false;
        this.fallback(sessionId, reason);
        return true;
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
        for (const [ownerProjectId, entries] of groups) {
            const owner = this.options.database.getProject(ownerProjectId);
            let topologyValidation: TopologyValidation = { status: 'unavailable' };
            if (owner)
                try {
                    topologyValidation = {
                        status: 'available',
                        topology: await this.loadTopology(owner.rootPath),
                    };
                } catch {
                    // Every Session in this owner group receives the same fail-closed result.
                }
            for (const entry of entries)
                await this.validateBinding(entry.sessionId, entry.binding, topologyValidation);
        }
    }

    projectDeleted(affectedSessionIds: readonly string[]): void {
        for (const sessionId of affectedSessionIds) {
            const session = this.options.database.getSession(sessionId);
            if (session) this.publishChange(session, 'fallback', 'project_deleted');
        }
    }

    /** Stops new background work and waits for any topology read that already crossed the boundary. */
    async close(): Promise<void> {
        this.closed = true;
        if (this.signalTimer) clearTimeout(this.signalTimer);
        this.signalTimer = undefined;
        this.pendingSignals.clear();
        this.candidates.clear();
        await this.queue;
    }

    private enqueue(run: () => Promise<void>): void {
        if (this.closed) return;
        this.queue = this.queue
            .then(() => (this.closed ? undefined : run()))
            .catch((error: unknown) => {
                if (!this.closed)
                    this.options.logger.write('warn', 'workbench_root.topology_failed', {
                        fields: { error: errorMessage(error, 'unknown') },
                    });
            });
    }

    private flushSignals(): void {
        this.signalTimer = undefined;
        const signals = [...this.pendingSignals.values()];
        this.pendingSignals.clear();
        this.enqueue(() => this.refreshForSignals(signals));
    }

    private async primeSessionNow(sessionId: string): Promise<void> {
        const session = this.options.database.getSession(sessionId);
        if (!session) return;
        const owner = this.options.database.getProject(session.projectId);
        if (owner) await this.primeProjectNow(owner.rootPath);
    }

    private async primeProjectNow(rootPath: string): Promise<void> {
        const startedAt = performance.now();
        try {
            const topology = await this.loadTopology(rootPath);
            if (!this.topologySnapshots.has(topology.repositoryKey))
                this.rememberTopology(topology);
            this.options.logger.write('debug', 'workbench_root.topology_primed', {
                durationMs: performance.now() - startedAt,
                fields: { worktreeCount: topology.worktrees.length },
            });
        } catch {
            // A non-Git Project has no automatic worktree candidates; manual Project use remains.
        }
    }

    /**
     * Attributes a topology delta only when exactly one Session signaled for that repository in the
     * debounce batch. Processing order can therefore never assign a shared delta to a random Agent.
     */
    private async refreshForSignals(signals: readonly AgentLifecycleSignal[]): Promise<void> {
        const startedAt = performance.now();
        const contexts: Array<{ ownerRoot: string; session: SessionRecord }> = [];
        for (const signal of signals) {
            const terminal = this.options.database.getTerminal(signal.terminalId);
            if (!terminal || terminal.provider !== signal.provider) continue;
            const initialSession = this.options.database.getSession(terminal.sessionId);
            if (!initialSession) continue;
            await this.validateSession(initialSession.id);
            const session = this.options.database.getSession(initialSession.id);
            if (!session) continue;
            const owner = this.options.database.getProject(session.projectId);
            if (owner) contexts.push({ ownerRoot: owner.rootPath, session });
        }
        const topologyByOwnerRoot = new Map<string, GitWorktreeTopology>();
        await Promise.all(
            [...new Set(contexts.map(({ ownerRoot }) => ownerRoot))].map(async (ownerRoot) => {
                try {
                    topologyByOwnerRoot.set(ownerRoot, await this.loadTopology(ownerRoot));
                } catch {
                    // A failed structured Git read cannot produce a candidate.
                }
            }),
        );
        const groups = new Map<
            string,
            Array<{
                current: Map<string, string>;
                session: SessionRecord;
                topology: GitWorktreeTopology;
            }>
        >();
        for (const context of contexts) {
            const topology = topologyByOwnerRoot.get(context.ownerRoot);
            if (!topology) continue;
            const entries = groups.get(topology.repositoryKey) ?? [];
            entries.push({ current: topologyByRoot(topology), session: context.session, topology });
            groups.set(topology.repositoryKey, entries);
        }
        for (const [repositoryKey, entries] of groups) {
            const previous = this.topologySnapshots.get(repositoryKey);
            const current = entries[0].current;
            this.rememberTopology(entries[0].topology);
            if (!previous) continue;
            const sessionIds = new Set(entries.map(({ session }) => session.id));
            const topologies = new Set(
                entries.map(({ current: value }) => topologyFingerprint(value)),
            );
            const additions = [...current.keys()].filter((rootPath) => !previous.has(rootPath));
            const unique = sessionIds.size === 1 && topologies.size === 1 && additions.length === 1;
            this.options.logger.write('debug', 'workbench_root.topology_refreshed', {
                durationMs: performance.now() - startedAt,
                fields: {
                    additions: additions.length,
                    reason: unique ? 'unique' : additions.length === 0 ? 'none' : 'ambiguous',
                    sessionCount: sessionIds.size,
                },
            });
            if (!unique || this.options.behavior() === 'ignore') continue;
            const session = entries[0].session;
            const rootPath = additions[0];
            const authorized = this.options.database.findProjectByRootPath(rootPath);
            if (authorized && this.options.behavior() === 'continueWhenAuthorized') {
                await this.select(session.id, authorized.id);
                continue;
            }
            this.addCandidate({ repositoryKey, rootPath, sessionId: session.id });
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

    private rememberTopology(topology: GitWorktreeTopology): void {
        this.topologySnapshots.delete(topology.repositoryKey);
        this.topologySnapshots.set(topology.repositoryKey, topologyByRoot(topology));
        while (this.topologySnapshots.size > MAX_TOPOLOGY_SNAPSHOTS) {
            const oldest = this.topologySnapshots.keys().next().value;
            if (!oldest) break;
            this.topologySnapshots.delete(oldest);
        }
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
                ...(reason === 'fallback' ? { returnedProjectTitle: owner.displayTitle } : {}),
            },
        });
        if (fallbackReason)
            this.options.logger.write('warn', 'workbench_root.fallback', {
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
    | 'session.workbenchRoots'
>;

/** Keeps the Workbench Root protocol surface beside its state machine instead of in bootstrap. */
export function createWorkbenchRootHandlers(
    service: WorkbenchRootService,
    mainOwned: (method: 'session.authorizeWorkbenchRoot' | 'session.continueInWorktree') => never,
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
        'session.validateWorkbenchRoots': async ({ sessionId }) => {
            await service.validate(sessionId);
            return null;
        },
    };
}
