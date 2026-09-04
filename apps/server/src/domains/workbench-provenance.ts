import type { AgentProvider, NewWorktreeBehavior, TerminalRecord } from '@caxri/protocol';
import { CaxriError, errorMessage } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { AgentEndpointLifecycle } from './agent-endpoints';
import type { AgentCoordinator, AgentLifecycleSignal } from './agents';
import type { CaxriDatabase } from './db';
import type { GitService, GitWorktreeTopology } from './git';
import type { WorkbenchRootService } from './workbench-roots';

const MAX_PENDING_CREATIONS = 256;
const MAX_PENDING_CREATION_VALIDATIONS = 256;
const MAX_PROVENANCE_BASELINES = 256;
const PENDING_CREATION_TTL_MS = 60_000;
const PRE_TOOL_TOPOLOGY_TIMEOUT_MS = 1_500;
const SHELL_VALIDATION_SETTLE_MS = 100;
const workbenchRootLogEvents = logEventCatalog.workbenchRoot;

export interface WorktreeProvenanceScope {
    launchId: string;
    projectId: string;
    provider: AgentProvider;
    sessionId: string;
    terminalId: string;
}

interface WorktreeProvenanceBaseline extends WorktreeProvenanceScope {
    repositoryKey: string;
}

interface PendingWorktreeCreation {
    ambiguous: boolean;
    baseline: WorktreeProvenanceBaseline;
    createdAt: number;
    rootPaths?: ReadonlySet<string>;
}

interface AttributableWorktreeCreation {
    baseline: WorktreeProvenanceBaseline;
    key: string;
    ownerRoot: string;
    pending: PendingWorktreeCreation;
    rootPaths: ReadonlySet<string>;
}

interface AgentWorktreeAttributionOptions {
    addCandidate(input: { repositoryKey: string; rootPath: string; sessionId: string }): void;
    behavior(): NewWorktreeBehavior;
    database: CaxriDatabase;
    git: GitService;
    logger: StructuredLogger;
    runQueued<T>(run: () => Promise<T>): Promise<T>;
    selectAuthorized(
        sessionId: string,
        projectId: string,
        isStillAuthorized: () => boolean,
    ): Promise<void>;
}

function launchKey(reference: { launchId: string; terminalId: string }): string {
    return JSON.stringify([reference.terminalId, reference.launchId]);
}

function creationKey(reference: {
    agentToolUseId?: string;
    launchId: string;
    terminalId: string;
}): string | undefined {
    return reference.agentToolUseId
        ? JSON.stringify([reference.terminalId, reference.launchId, reference.agentToolUseId])
        : undefined;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
    let cancelTimeout = () => {};
    try {
        return await Promise.race([
            promise,
            new Promise<undefined>((resolve) => {
                const timer = setTimeout(resolve, timeoutMs);
                cancelTimeout = () => clearTimeout(timer);
            }),
        ]);
    } finally {
        cancelTimeout();
    }
}

interface BoundedSerialBatcherOptions<Key> {
    capacity: number;
    delayMs: number;
    onCapacity(): void;
    run(keys: readonly Key[]): Promise<void>;
}

/**
 * Coalesces a high-frequency lifecycle boundary into one active batch plus one bounded pending set. New keys received
 * while Git work is in flight cannot append promise-chain nodes; they become one later batch instead.
 */
export class BoundedSerialBatcher<Key> {
    private readonly pending = new Set<Key>();
    private active = false;
    private closed = false;
    private timer?: NodeJS.Timeout;

    constructor(private readonly options: BoundedSerialBatcherOptions<Key>) {}

    private arm(): void {
        if (this.active || this.closed || this.timer || this.pending.size === 0) return;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.flush();
        }, this.options.delayMs);
        this.timer.unref();
    }

    private flush(): void {
        if (this.active || this.closed) return;
        const keys = [...this.pending];
        this.pending.clear();
        this.active = true;
        // The lifecycle callback is synchronous; the batch owns and contains its asynchronous failure.
        // eslint-disable-next-line no-void -- the finally block exclusively schedules the next bounded batch
        void this.options
            .run(keys)
            .catch(() => {})
            .finally(() => {
                this.active = false;
                this.arm();
            });
    }

    schedule(key: Key): boolean {
        if (this.closed) return false;
        if (!this.pending.has(key) && this.pending.size >= this.options.capacity) {
            this.options.onCapacity();
            return false;
        }
        this.pending.add(key);
        this.arm();
        return true;
    }

    close(): void {
        this.closed = true;
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        this.pending.clear();
    }
}

/**
 * Pairs one classified Bash PreToolUse hook with its outcome and proves a unique linked-worktree addition without
 * accepting commands, paths, output, or CLI reports as authority.
 */
export class AgentWorktreeAttribution {
    private readonly creationValidations: BoundedSerialBatcher<string>;
    private readonly pendingCreations = new Map<string, PendingWorktreeCreation>();
    private readonly provenanceBaselines = new Map<string, WorktreeProvenanceBaseline>();
    private creationOverflowedUntil = 0;

    constructor(private readonly options: AgentWorktreeAttributionOptions) {
        this.creationValidations = new BoundedSerialBatcher({
            capacity: MAX_PENDING_CREATION_VALIDATIONS,
            delayMs: SHELL_VALIDATION_SETTLE_MS,
            onCapacity: () =>
                this.options.logger.write('warn', workbenchRootLogEvents.validationDropped, {
                    fields: { reason: 'creation_capacity' },
                }),
            run: (keys) => this.options.runQueued(() => this.attribute(keys)),
        });
    }

    private hasValidTerminal(signal: AgentLifecycleSignal): boolean {
        const terminal = this.options.database.getTerminal(signal.terminalId);
        return Boolean(
            terminal &&
            terminal.provider === signal.provider &&
            this.options.database.getSession(terminal.sessionId),
        );
    }

    private rememberBaseline(baseline: WorktreeProvenanceBaseline): void {
        const key = launchKey(baseline);
        this.provenanceBaselines.delete(key);
        this.provenanceBaselines.set(key, baseline);
        while (this.provenanceBaselines.size > MAX_PROVENANCE_BASELINES) {
            const oldest = this.provenanceBaselines.keys().next().value;
            if (!oldest) break;
            this.provenanceBaselines.delete(oldest);
        }
    }

    private prunePendingCreations(): void {
        const cutoff = Date.now() - PENDING_CREATION_TTL_MS;
        for (const [key, pending] of this.pendingCreations)
            if (pending.createdAt <= cutoff) this.pendingCreations.delete(key);
    }

    /**
     * Reserves capacity before entering the serialized Git queue. Every overlapping PreToolUse window for one
     * repository stays as an ambiguous tombstone until its own outcome or TTL, so staggered PostToolUse batches cannot
     * attribute the same addition to different Sessions.
     */
    private reservePendingCreation(
        signal: AgentLifecycleSignal,
    ): { key: string; pending: PendingWorktreeCreation } | undefined {
        this.prunePendingCreations();
        const key = creationKey(signal);
        if (!key) return undefined;
        const baseline = this.provenanceBaselines.get(launchKey(signal));
        if (!baseline || baseline.provider !== signal.provider) return undefined;
        const existing = this.pendingCreations.get(key);
        if (existing) {
            existing.ambiguous = true;
            return undefined;
        }
        const now = Date.now();
        if (now < this.creationOverflowedUntil) return undefined;
        if (this.pendingCreations.size >= MAX_PENDING_CREATIONS) {
            for (const pending of this.pendingCreations.values()) pending.ambiguous = true;
            this.creationOverflowedUntil = now + PENDING_CREATION_TTL_MS;
            this.options.logger.write('warn', workbenchRootLogEvents.validationDropped, {
                fields: { reason: 'creation_pair_capacity' },
            });
            return undefined;
        }
        const pending: PendingWorktreeCreation = {
            ambiguous: false,
            baseline,
            createdAt: now,
        };
        for (const candidate of this.pendingCreations.values())
            if (candidate.baseline.repositoryKey === baseline.repositoryKey) {
                candidate.ambiguous = true;
                pending.ambiguous = true;
            }
        this.pendingCreations.set(key, pending);
        return { key, pending };
    }

    private isCurrentPending(key: string, pending: PendingWorktreeCreation): boolean {
        return !pending.ambiguous && this.pendingCreations.get(key) === pending;
    }

    /**
     * Blocks the exact `git worktree add` PreToolUse hook until Server Core has captured a bounded, authoritative
     * before-snapshot. A timeout records nothing, so a later outcome cannot fall back to the broader launch window.
     */
    private async capture(key: string, pending: PendingWorktreeCreation): Promise<void> {
        if (!this.isCurrentPending(key, pending)) return;
        const { baseline } = pending;
        const terminal = this.options.database.getTerminal(baseline.terminalId);
        const session = this.options.database.getSession(baseline.sessionId);
        const owner = this.options.database.getProject(baseline.projectId);
        if (
            !terminal ||
            !session ||
            !owner ||
            terminal.sessionId !== baseline.sessionId ||
            terminal.provider !== baseline.provider ||
            session.projectId !== baseline.projectId
        )
            return;
        const startedAt = performance.now();
        try {
            const remainingMs = pending.createdAt + PRE_TOOL_TOPOLOGY_TIMEOUT_MS - Date.now();
            if (remainingMs <= 0) {
                this.options.logger.write('debug', workbenchRootLogEvents.provenanceUnavailable, {
                    durationMs: performance.now() - startedAt,
                    fields: { error: 'pre_tool_queue_timeout', terminalId: baseline.terminalId },
                });
                return;
            }
            const topology = await withTimeout(
                this.options.git.worktreeTopology(owner.rootPath),
                remainingMs,
            );
            if (!topology) {
                this.options.logger.write('debug', workbenchRootLogEvents.provenanceUnavailable, {
                    durationMs: performance.now() - startedAt,
                    fields: { error: 'pre_tool_timeout', terminalId: baseline.terminalId },
                });
                return;
            }
            const currentTerminal = this.options.database.getTerminal(baseline.terminalId);
            const currentSession = this.options.database.getSession(baseline.sessionId);
            if (
                !currentTerminal ||
                !currentSession ||
                !this.isCurrentPending(key, pending) ||
                this.provenanceBaselines.get(launchKey(baseline)) !== baseline ||
                topology.repositoryKey !== baseline.repositoryKey ||
                currentTerminal.sessionId !== baseline.sessionId ||
                currentTerminal.provider !== baseline.provider ||
                currentSession.projectId !== baseline.projectId
            )
                return;
            pending.rootPaths = new Set(topology.worktrees.map(({ rootPath }) => rootPath));
        } catch (error) {
            this.options.logger.write('debug', workbenchRootLogEvents.provenanceUnavailable, {
                durationMs: performance.now() - startedAt,
                fields: {
                    error: errorMessage(error, 'unknown'),
                    terminalId: baseline.terminalId,
                },
            });
        }
    }

    private async attributeRepository(
        repoKey: string,
        entries: readonly AttributableWorktreeCreation[],
    ): Promise<void> {
        let topology: GitWorktreeTopology;
        try {
            topology = await this.options.git.worktreeTopology(entries[0].ownerRoot);
        } catch {
            return;
        }
        if (topology.repositoryKey !== repoKey) return;
        const live = entries.filter(
            ({ baseline, key, pending }) =>
                !pending.ambiguous &&
                this.pendingCreations.get(key) === pending &&
                this.provenanceBaselines.get(launchKey(baseline)) === baseline,
        );
        if (live.length !== 1) return;
        const [{ baseline, key, pending, rootPaths }] = live;
        const additions = topology.worktrees.filter(({ rootPath }) => !rootPaths.has(rootPath));
        if (additions.length !== 1) return;
        const [addition] = additions;
        if (this.options.behavior() === 'ignore') return;
        const authorized = this.options.database.findProjectByRootPath(addition.rootPath);
        if (authorized && this.options.behavior() === 'continueWhenAuthorized') {
            try {
                await this.options.selectAuthorized(
                    baseline.sessionId,
                    authorized.id,
                    () =>
                        !pending.ambiguous &&
                        this.pendingCreations.get(key) === pending &&
                        this.provenanceBaselines.get(launchKey(baseline)) === baseline,
                );
            } catch {
                // A retired launch or a changed topology makes the observed intent inert.
            }
            return;
        }
        if (
            pending.ambiguous ||
            this.pendingCreations.get(key) !== pending ||
            this.provenanceBaselines.get(launchKey(baseline)) !== baseline
        )
            return;
        this.options.addCandidate({
            repositoryKey: topology.repositoryKey,
            rootPath: addition.rootPath,
            sessionId: baseline.sessionId,
        });
    }

    /**
     * Converts paired hook intent into one candidate only when the current launch, durable ownership, and one forced
     * Git topology delta agree. Multiple tool outcomes or additions in one repository batch are ambiguous and inert.
     */
    private async attribute(keys: readonly string[]): Promise<void> {
        this.prunePendingCreations();
        const consumed = new Map<string, PendingWorktreeCreation>();
        const groups = new Map<string, AttributableWorktreeCreation[]>();
        try {
            for (const key of keys) {
                const pending = this.pendingCreations.get(key);
                if (!pending) continue;
                consumed.set(key, pending);
                const { baseline, rootPaths } = pending;
                if (
                    !rootPaths ||
                    pending.ambiguous ||
                    this.provenanceBaselines.get(launchKey(baseline)) !== baseline
                )
                    continue;
                const terminal = this.options.database.getTerminal(baseline.terminalId);
                const session = this.options.database.getSession(baseline.sessionId);
                const owner = this.options.database.getProject(baseline.projectId);
                if (
                    !terminal ||
                    !session ||
                    !owner ||
                    terminal.sessionId !== baseline.sessionId ||
                    terminal.provider !== baseline.provider ||
                    session.projectId !== baseline.projectId
                )
                    continue;
                const entries = groups.get(baseline.repositoryKey) ?? [];
                entries.push({ baseline, key, pending, ownerRoot: owner.rootPath, rootPaths });
                groups.set(baseline.repositoryKey, entries);
            }

            /**
             * Keep forced Git reads serialized without placing an `await` inside the repository loop.
             */
            /* eslint-disable unicorn/prefer-await -- the promise chain preserves bounded serial Git reads. */
            await [...groups].reduce<Promise<void>>(
                (pending, [repoKey, entries]) =>
                    pending.then(() => this.attributeRepository(repoKey, entries)),
                Promise.resolve(),
            );
            /* eslint-enable unicorn/prefer-await */
        } finally {
            for (const [key, pending] of consumed)
                if (this.pendingCreations.get(key) === pending) this.pendingCreations.delete(key);
        }
    }

    async prime(scope: WorktreeProvenanceScope): Promise<boolean> {
        return this.options.runQueued(async () => {
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
                const topology = await this.options.git.worktreeTopology(owner.rootPath);
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
                this.rememberBaseline({ ...scope, repositoryKey: topology.repositoryKey });
                this.options.logger.write('debug', workbenchRootLogEvents.provenancePrimed, {
                    durationMs: performance.now() - startedAt,
                    fields: {
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

    retireTerminal(terminalId: string): void {
        for (const [key, baseline] of this.provenanceBaselines)
            if (baseline.terminalId === terminalId) this.provenanceBaselines.delete(key);
        for (const [key, pending] of this.pendingCreations)
            if (pending.baseline.terminalId === terminalId) this.pendingCreations.delete(key);
    }

    async observeStarted(signal: AgentLifecycleSignal): Promise<boolean> {
        if (!this.hasValidTerminal(signal)) return false;
        if (signal.worktreeCreateIntent && signal.agentToolUseId) {
            const reservation = this.reservePendingCreation(signal);
            if (reservation && !reservation.pending.ambiguous)
                await this.options.runQueued(() =>
                    this.capture(reservation.key, reservation.pending),
                );
        }
        return true;
    }

    observeFinished(signal: AgentLifecycleSignal): boolean {
        if (!this.hasValidTerminal(signal)) return false;
        const key = creationKey(signal);
        if (key && signal.worktreeCreateIntent) this.creationValidations.schedule(key);
        return true;
    }

    observeFailed(signal: AgentLifecycleSignal): boolean {
        if (!this.hasValidTerminal(signal)) return false;
        const key = creationKey(signal);
        if (key && signal.worktreeCreateIntent) this.pendingCreations.delete(key);
        return true;
    }

    close(): void {
        this.creationValidations.close();
        this.pendingCreations.clear();
        this.provenanceBaselines.clear();
        this.creationOverflowedUntil = 0;
    }
}

export function handleAgentLifecycleSignal(
    coordinator: AgentCoordinator,
    workbenchRoots: WorkbenchRootService,
    signal: AgentLifecycleSignal,
): boolean | Promise<boolean> {
    /**
     * Runs on every phase, ahead of phase routing: the provider reports its own working directory on all of them, so an
     * Agent that moved itself is observable without depending on which tool did it. The check short-circuits on an
     * unchanged directory and never blocks the phase's own handling.
     */
    workbenchRoots.observeAgentCwd(signal);
    if (signal.phase === 'shellToolStarted') return workbenchRoots.observeShellToolStarted(signal);
    if (signal.phase === 'shellToolFinished')
        return workbenchRoots.observeShellToolFinished(signal);
    if (signal.phase === 'shellToolFailed') return workbenchRoots.observeShellToolFailed(signal);
    return coordinator.observeLifecycleSignal(signal);
}

export async function retireAgentWorkbenchProvenance(options: {
    endpoints: AgentEndpointLifecycle | undefined;
    logger: StructuredLogger;
    terminalId: string;
    workbenchRoots: WorkbenchRootService;
}): Promise<void> {
    options.workbenchRoots.retireTerminal(options.terminalId);
    try {
        await options.endpoints?.retire(options.terminalId);
    } catch (error: unknown) {
        options.logger.write('warn', logEventCatalog.agentEndpoint.retireFailed, {
            fields: {
                terminalId: options.terminalId,
                error: error instanceof Error ? error.message : String(error),
            },
        });
    }
}

/**
 * Records the hook launch's owning Git topology before the Agent can spawn, independently of Agent Endpoint support.
 */
export async function primeAgentWorkbenchProvenance(options: {
    launchId: string;
    projectId: string;
    terminal: TerminalRecord;
    workbenchRoots: WorkbenchRootService;
}): Promise<void> {
    const { launchId, projectId, terminal, workbenchRoots } = options;
    if (terminal.kind === 'shell')
        throw new CaxriError('CONFLICT', 'Shell Terminals cannot establish Agent provenance');
    await workbenchRoots.primeAgentLaunch({
        launchId,
        projectId,
        provider: terminal.kind,
        sessionId: terminal.sessionId,
        terminalId: terminal.id,
    });
}
