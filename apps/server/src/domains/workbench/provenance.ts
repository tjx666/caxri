import type { AgentProvider } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { errorLogFields, logEventCatalog } from '@caxri/system';
import { withTimeout } from '@caxri/utils';

import type { AgentLifecycleSignal, AgentSignalDecision } from '../agents';
import type { CaxriDatabase } from '../db';
import type { GitService, GitWorktreeTopology } from '../git';
import { BoundedSerialBatcher } from './bounded-serial-batcher';
import type { ProvenanceUnavailableReason } from './provenance-support';
import {
    creationKey,
    isSameWorkbenchBinding,
    launchKey,
    selectAddition,
} from './provenance-support';

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
    /**
     * The normalized absolute path the command named. Only a filter over Git-reported additions: it keeps overlapping
     * creations in one repository individually attributable, and never introduces or authorizes a root.
     */
    declaredPath?: string;
    isCurrentLaunch(): boolean;
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
    followWorktree(
        input: { repositoryKey: string; rootPath: string; sessionId: string },
        isStillAuthorized: () => boolean,
    ): Promise<void>;
    database: CaxriDatabase;
    git: GitService;
    logger: StructuredLogger;
    runQueued<T>(run: () => Promise<T>): Promise<T>;
}

/**
 * Pairs one classified Bash PreToolUse hook with its outcome and proves a unique linked-worktree addition without
 * accepting commands, paths, output, or CLI reports as authority.
 */
export class AgentWorktreeAttribution {
    private readonly creationValidations: BoundedSerialBatcher<string>;
    private readonly pendingCreations = new Map<string, PendingWorktreeCreation>();
    private readonly provenanceBaselines = new Map<string, WorktreeProvenanceBaseline>();
    private readonly pendingPrimings = new Map<string, Promise<boolean>>();
    /**
     * Creation starts still priming or capturing, so an outcome that overtakes its start pairs with it once it lands.
     */
    private readonly startingCreations = new Map<string, Promise<AgentSignalDecision>>();
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

    private logUnavailable(reason: ProvenanceUnavailableReason, terminalId: string): void {
        this.options.logger.write('info', workbenchRootLogEvents.provenanceUnavailable, {
            fields: { reason, terminalId },
        });
    }

    /**
     * Names which half of the attribution scope is missing so a dropped shell-tool signal is diagnosable from the log
     * rather than collapsing three distinct causes into one silent `false`.
     */
    private terminalScope(signal: AgentLifecycleSignal): AgentSignalDecision {
        const terminal = this.options.database.getTerminal(signal.terminalId);
        if (!terminal) return 'terminalMissing';
        if (terminal.provider !== signal.provider) return 'providerMismatch';
        if (!this.options.database.getSession(terminal.sessionId)) return 'sessionMissing';
        return 'accepted';
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
     * repository stays as a tombstone until its own outcome or TTL. A creation without a declared path becomes
     * ambiguous (and inert) as soon as another creation overlaps it, so staggered PostToolUse batches cannot attribute
     * the same addition to different Sessions. Creations that declare a path stay attributable: each is resolved
     * against its own before-snapshot and its own path, independent of when a sibling's outcome arrives.
     */
    private reservePendingCreation(
        signal: AgentLifecycleSignal,
        isCurrentLaunch: () => boolean,
        createdAt: number,
    ): { key: string; pending: PendingWorktreeCreation } | undefined {
        this.prunePendingCreations();
        const key = creationKey(signal);
        if (!key) return undefined;
        const baseline = this.provenanceBaselines.get(launchKey(signal));
        if (!baseline || baseline.provider !== signal.provider) {
            this.logUnavailable('no_baseline', signal.terminalId);
            return undefined;
        }
        const existing = this.pendingCreations.get(key);
        if (existing) {
            existing.ambiguous = true;
            this.logUnavailable('duplicate_start', signal.terminalId);
            return undefined;
        }
        const now = Date.now();
        if (now < this.creationOverflowedUntil) {
            this.logUnavailable('creation_overflow', signal.terminalId);
            return undefined;
        }
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
            isCurrentLaunch,
            baseline,
            createdAt,
            ...(signal.worktreeCreatePath && { declaredPath: signal.worktreeCreatePath }),
        };
        for (const candidate of this.pendingCreations.values())
            if (candidate.baseline.repositoryKey === baseline.repositoryKey) {
                if (!candidate.declaredPath) candidate.ambiguous = true;
                if (!pending.declaredPath) pending.ambiguous = true;
            }
        this.pendingCreations.set(key, pending);
        return { key, pending };
    }

    private isCurrentPending(key: string, pending: PendingWorktreeCreation): boolean {
        return (
            !pending.ambiguous &&
            pending.isCurrentLaunch() &&
            this.pendingCreations.get(key) === pending
        );
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
                    ...errorLogFields(error),
                    terminalId: baseline.terminalId,
                },
            });
        }
    }

    private async attributeRepository(
        repoKey: string,
        entries: readonly AttributableWorktreeCreation[],
    ): Promise<void> {
        const initiatingBindings = new Map(
            entries.map(({ baseline }) => [
                baseline.sessionId,
                this.options.database.getSessionWorkbenchBinding(baseline.sessionId),
            ]),
        );
        let topology: GitWorktreeTopology;
        try {
            topology = await this.options.git.worktreeTopology(entries[0].ownerRoot);
        } catch {
            for (const { baseline } of entries)
                this.logUnavailable('topology_unavailable', baseline.terminalId);
            return;
        }
        if (topology.repositoryKey !== repoKey) {
            for (const { baseline } of entries)
                this.logUnavailable('repository_mismatch', baseline.terminalId);
            return;
        }
        const live: AttributableWorktreeCreation[] = [];
        for (const entry of entries) {
            if (
                this.isCurrentPending(entry.key, entry.pending) &&
                this.provenanceBaselines.get(launchKey(entry.baseline)) === entry.baseline
            )
                live.push(entry);
            else
                this.logUnavailable(
                    entry.pending.ambiguous ? 'concurrent_creations' : 'stale_pending',
                    entry.baseline.terminalId,
                );
        }
        /**
         * Without a declared path the whole repository batch must hold exactly one live creation, as before.
         */
        const isBatchAmbiguous =
            live.length !== 1 && live.some(({ pending }) => !pending.declaredPath);
        /* eslint-disable unicorn/prefer-await -- serial on purpose: each follow mutates a binding the next entry reads. */
        await live.reduce<Promise<void>>(
            (previous, entry) =>
                previous.then(() =>
                    isBatchAmbiguous && !entry.pending.declaredPath
                        ? this.logUnavailable('concurrent_creations', entry.baseline.terminalId)
                        : this.attributeEntry(topology, entry, initiatingBindings),
                ),
            Promise.resolve(),
        );
        /* eslint-enable unicorn/prefer-await */
    }

    /**
     * Attributes one creation from the additions Git reports relative to its own before-snapshot. A declared path only
     * picks among those additions, so a sibling's new worktree can neither hide nor become this one; a path that
     * another outstanding creation in the repository also declared, or that matches no addition, follows nothing.
     */
    private async attributeEntry(
        topology: GitWorktreeTopology,
        entry: AttributableWorktreeCreation,
        initiatingBindings: ReadonlyMap<
            string,
            ReturnType<CaxriDatabase['getSessionWorkbenchBinding']>
        >,
    ): Promise<void> {
        const { baseline, key, pending, rootPaths } = entry;
        const isClaimed = [...this.pendingCreations].some(
            ([otherKey, other]) =>
                otherKey !== key &&
                pending.declaredPath !== undefined &&
                other.declaredPath === pending.declaredPath &&
                other.baseline.repositoryKey === baseline.repositoryKey,
        );
        const selected = isClaimed
            ? { reason: 'concurrent_creations' as const }
            : await selectAddition(topology, rootPaths, pending.declaredPath);
        if ('reason' in selected) this.logUnavailable(selected.reason, baseline.terminalId);
        else await this.follow(topology, entry, selected.rootPath, initiatingBindings);
    }

    private async follow(
        topology: GitWorktreeTopology,
        { baseline, key, pending }: AttributableWorktreeCreation,
        rootPath: string,
        initiatingBindings: ReadonlyMap<
            string,
            ReturnType<CaxriDatabase['getSessionWorkbenchBinding']>
        >,
    ): Promise<void> {
        try {
            await this.options.followWorktree(
                {
                    repositoryKey: topology.repositoryKey,
                    rootPath,
                    sessionId: baseline.sessionId,
                },
                () =>
                    this.isCurrentPending(key, pending) &&
                    isSameWorkbenchBinding(
                        initiatingBindings.get(baseline.sessionId),
                        this.options.database.getSessionWorkbenchBinding(baseline.sessionId),
                    ) &&
                    this.pendingCreations.get(key) === pending &&
                    this.provenanceBaselines.get(launchKey(baseline)) === baseline,
            );
        } catch {
            /**
             * A vanished or replaced root must not discard attribution for other repositories in this batch.
             */
            this.options.logger.write('debug', workbenchRootLogEvents.provenanceUnavailable, {
                fields: { reason: 'selection_unavailable', terminalId: baseline.terminalId },
            });
        }
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
                if (!rootPaths) {
                    this.logUnavailable(
                        pending.ambiguous ? 'concurrent_creations' : 'no_snapshot',
                        baseline.terminalId,
                    );
                    continue;
                }
                if (
                    !this.isCurrentPending(key, pending) ||
                    this.provenanceBaselines.get(launchKey(baseline)) !== baseline
                ) {
                    this.logUnavailable(
                        pending.ambiguous ? 'concurrent_creations' : 'stale_pending',
                        baseline.terminalId,
                    );
                    continue;
                }
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
                ) {
                    this.logUnavailable('scope_changed', baseline.terminalId);
                    continue;
                }
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

    private async startCreation(
        signal: AgentLifecycleSignal,
        isCurrentLaunch: () => boolean,
    ): Promise<AgentSignalDecision> {
        const startedAt = Date.now();
        /**
         * A manually resumed Agent inherits Shell hook authority, not the managed Agent's launch callback. Establish
         * its repository identity while PreToolUse still blocks execution (a Chat provider that cannot block reports
         * the start as early as it can); never infer a creation from the wider Shell lifetime. The current-launch
         * predicate fences restoration and retirement races.
         */
        if (this.provenanceBaselines.get(launchKey(signal))?.provider !== signal.provider) {
            const terminal = this.options.database.getTerminal(signal.terminalId)!;
            const session = this.options.database.getSession(terminal.sessionId)!;
            const deadline = startedAt + PRE_TOOL_TOPOLOGY_TIMEOUT_MS;
            const primed = await withTimeout(
                this.prime(
                    {
                        launchId: signal.launchId,
                        projectId: session.projectId,
                        provider: signal.provider,
                        sessionId: session.id,
                        terminalId: terminal.id,
                    },
                    () => isCurrentLaunch() && Date.now() < deadline,
                ),
                PRE_TOOL_TOPOLOGY_TIMEOUT_MS,
            );
            if (!primed) {
                const isCurrent = isCurrentLaunch();
                this.options.logger.write('info', workbenchRootLogEvents.provenanceUnavailable, {
                    durationMs: Date.now() - startedAt,
                    fields: {
                        reason: isCurrent ? 'pre_tool_prime_unavailable' : 'stale_launch',
                        terminalId: signal.terminalId,
                    },
                });
                return isCurrent ? 'accepted' : 'staleLaunch';
            }
        }
        if (!isCurrentLaunch()) return 'staleLaunch';
        const reservation = this.reservePendingCreation(signal, isCurrentLaunch, startedAt);
        if (reservation && !reservation.pending.ambiguous)
            await this.options.runQueued(() => this.capture(reservation.key, reservation.pending));
        return 'accepted';
    }

    /**
     * Runs `settle` once the creation's own start has captured its before-snapshot, or at once when none is starting. A
     * Chat provider that cannot hold a command back (Codex, ACP) reports its outcome without waiting for the start to
     * be processed, so a fast command's outcome may arrive while the start is still priming or capturing.
     */
    private afterStart(key: string, settle: () => void): void {
        const starting = this.startingCreations.get(key);
        if (!starting) {
            settle();
            return;
        }
        void starting.catch(() => 'accepted').then(settle);
    }

    async prime(
        scope: WorktreeProvenanceScope,
        isCurrentLaunch: () => boolean = () => true,
    ): Promise<boolean> {
        const key = JSON.stringify([launchKey(scope), scope.provider]);
        const existing = this.pendingPrimings.get(key);
        if (existing) return existing;
        if (this.pendingPrimings.size >= MAX_PROVENANCE_BASELINES) return false;
        const priming = this.options.runQueued(async () => {
            if (!isCurrentLaunch()) return false;
            if (this.provenanceBaselines.get(launchKey(scope))?.provider === scope.provider)
                return true;
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
                    !isCurrentLaunch() ||
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
                        ...errorLogFields(error),
                        terminalId: scope.terminalId,
                    },
                });
                return false;
            }
        });
        this.pendingPrimings.set(key, priming);
        try {
            return await priming;
        } finally {
            if (this.pendingPrimings.get(key) === priming) this.pendingPrimings.delete(key);
        }
    }

    retireTerminal(terminalId: string): void {
        for (const [key, baseline] of this.provenanceBaselines)
            if (baseline.terminalId === terminalId) this.provenanceBaselines.delete(key);
        for (const [key, pending] of this.pendingCreations)
            if (pending.baseline.terminalId === terminalId) this.pendingCreations.delete(key);
    }

    async observeStarted(
        signal: AgentLifecycleSignal,
        isCurrentLaunch: () => boolean,
    ): Promise<AgentSignalDecision> {
        if (!isCurrentLaunch()) return 'staleLaunch';
        const scope = this.terminalScope(signal);
        if (scope !== 'accepted') return scope;
        const key = signal.worktreeCreateIntent ? creationKey(signal) : undefined;
        if (!key) return 'accepted';
        const starting = this.startCreation(signal, isCurrentLaunch);
        this.startingCreations.set(key, starting);
        try {
            return await starting;
        } finally {
            if (this.startingCreations.get(key) === starting) this.startingCreations.delete(key);
        }
    }

    observeFinished(signal: AgentLifecycleSignal): AgentSignalDecision {
        const scope = this.terminalScope(signal);
        if (scope !== 'accepted') return scope;
        const key = creationKey(signal);
        if (key && signal.worktreeCreateIntent)
            this.afterStart(key, () => this.creationValidations.schedule(key));
        return 'accepted';
    }

    observeFailed(signal: AgentLifecycleSignal): AgentSignalDecision {
        const scope = this.terminalScope(signal);
        if (scope !== 'accepted') return scope;
        const key = creationKey(signal);
        if (key && signal.worktreeCreateIntent)
            this.afterStart(key, () => this.pendingCreations.delete(key));
        return 'accepted';
    }

    close(): void {
        this.creationValidations.close();
        this.pendingCreations.clear();
        this.startingCreations.clear();
        this.provenanceBaselines.clear();
        this.creationOverflowedUntil = 0;
    }
}
