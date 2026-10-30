import type {
    FullStateChangeReason,
    SessionArchiveWorktreeChoice,
    SessionArchiveWorktreePlan,
    SessionPullRequestState,
} from '@caxri/protocol';
import { isCaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { CaxriDatabase } from '../db';
import type { GitService, LinkedWorktreeRemoval, LinkedWorktreeRemovalInput } from '../git';
import type { SessionPullRequestResolver } from '../project-status';
import { isSameWorkbenchBinding } from './provenance';

/**
 * How long a removal waits after the archive. It covers an immediate reversal (Reopen Closed Item), so an accidental
 * archive never costs a worktree, and gives the processes parking just stopped time to release their files.
 */
const DEFAULT_REMOVAL_DELAY_MS = 10_000;
const BACKUP_COMMIT_MESSAGE = 'Back up uncommitted changes before Caxri removed this worktree';
const { worktreeArchiveCleanup } = logEventCatalog.workbenchRoot;

type LinkedWorktreeRefusal = Extract<LinkedWorktreeRemoval, { outcome: 'refused' }>['reason'];

type SessionBinding = NonNullable<ReturnType<CaxriDatabase['getSessionWorkbenchBinding']>>;

/**
 * Closed reason for every archive that did not remove a worktree, so the log measures how often the setting acts and
 * why it held back, without recording a path or a branch.
 */
type CleanupSkipReason =
    'kept' | 'unmerged' | 'restored' | 'rebound' | 'ineligible' | LinkedWorktreeRefusal;

/**
 * A worktree archiving may remove, captured before the archive and re-proven before the removal.
 */
export interface ArchivedWorktreeTarget {
    binding: SessionBinding;
    branch: string;
    ownerRoot: string;
    rootPath: string;
    worktreeProjectId: string;
}

export interface ArchivedWorktreeCleanupOptions {
    database: CaxriDatabase;
    /**
     * Removal delay; tests pass 0.
     */
    delayMs?: number;
    git: Pick<GitService, 'worktreeTopology'>;
    isEnabled(): boolean;
    logger: StructuredLogger;
    removeWorktree(input: LinkedWorktreeRemovalInput): Promise<LinkedWorktreeRemoval>;
    sendFullStateChange(reason: FullStateChangeReason): void;
}

/**
 * Removes the worktree an archived Session worked in when `workbench.removeWorktreeOnArchive` is on. Only a linked
 * worktree Caxri registered on the Session's own Project's behalf qualifies, never a main checkout or a folder the user
 * added as a Project, and only while no open Session still works in it. A merged pull request removes it without
 * asking; anything else needs the user's `remove` answer from the archive confirmation. The removal runs in the
 * background after a delay and re-proves every condition first, since the Session may have been restored meanwhile. It
 * stays outside the Workbench Root queue on purpose: that queue serializes Agent worktree following, and an archived
 * Session has no running Agent left to follow anything. The behavior follows Lody's archive cleanup, plus the merged
 * pull request condition.
 */
export class ArchivedWorktreeCleanup {
    private readonly delayMs: number;
    /**
     * One pending removal per Session, so a later archive decision (Undo, then archive again choosing Keep) replaces
     * the earlier one instead of racing it.
     */
    private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly removals = new Set<Promise<void>>();
    private isClosed = false;
    private resolvePullRequest?: SessionPullRequestResolver;

    constructor(private readonly options: ArchivedWorktreeCleanupOptions) {
        this.delayMs = options.delayMs ?? DEFAULT_REMOVAL_DELAY_MS;
    }

    private async track(removal: Promise<void>): Promise<void> {
        this.removals.add(removal);
        try {
            await removal;
        } finally {
            this.removals.delete(removal);
        }
    }

    private async remove(sessionId: string, target: ArchivedWorktreeTarget): Promise<void> {
        const startedAt = performance.now();
        try {
            const { database } = this.options;
            const session = database.getSession(sessionId);
            if (session?.archivedAt === undefined) {
                this.logSkipped(sessionId, 'restored', startedAt);
                return;
            }
            if (
                !isSameWorkbenchBinding(
                    target.binding,
                    database.getSessionWorkbenchBinding(sessionId),
                )
            ) {
                this.logSkipped(sessionId, 'rebound', startedAt);
                return;
            }
            const current = await this.findTarget(sessionId);
            if (current?.rootPath !== target.rootPath) {
                this.logSkipped(sessionId, 'ineligible', startedAt);
                return;
            }
            const removal = await this.options.removeWorktree({
                backupMessage: BACKUP_COMMIT_MESSAGE,
                ownerRoot: current.ownerRoot,
                rootPath: current.rootPath,
            });
            if (removal.outcome === 'refused') {
                this.logSkipped(sessionId, removal.reason, startedAt);
                return;
            }
            /**
             * The folder is gone, so every Session bound to it, all archived by now, returns to its own Project root.
             * Doing it here, silently, keeps a later restore from announcing a fallback the user caused.
             */
            for (const bound of database.listSessionsUsingWorkbenchProject(
                current.worktreeProjectId,
            ))
                database.selectWorkbenchProject(bound.id, bound.projectId);
            this.options.sendFullStateChange('session.workbenchRoot');
            this.options.logger.write('info', worktreeArchiveCleanup, {
                durationMs: performance.now() - startedAt,
                fields: {
                    isBackupCommitted: removal.isBackupCommitted,
                    outcome: 'removed',
                    sessionId,
                },
            });
            await this.refreshTopology(current.ownerRoot);
        } catch (error) {
            this.logFailed(sessionId, error, startedAt);
        }
    }

    /**
     * A forced read drops the removed root from the topology every Git reader shares. The removal already happened, so
     * a failed read only leaves that cache to its next refresh.
     */
    private async refreshTopology(ownerRoot: string): Promise<void> {
        try {
            await this.options.git.worktreeTopology(ownerRoot);
        } catch {
            // See above: nothing to undo.
        }
    }

    /**
     * The Session's Workbench Root when it is a linked worktree Caxri registered on the Session's own Project's behalf
     * and no other open Session works in it.
     */
    private async findTarget(sessionId: string): Promise<ArchivedWorktreeTarget | undefined> {
        const { database, git } = this.options;
        const binding = database.getSessionWorkbenchBinding(sessionId);
        if (!binding || binding.workbenchRootProjectId === binding.projectId) return undefined;
        const owner = database.getProject(binding.projectId);
        const worktree = database.getProject(binding.workbenchRootProjectId);
        if (!owner || worktree?.ownerProjectId !== owner.id) return undefined;
        const isShared = database
            .listSessionsUsingWorkbenchProject(worktree.id)
            .some((session) => session.id !== sessionId && session.archivedAt === undefined);
        if (isShared) return undefined;
        const topology = await git.worktreeTopology(owner.rootPath);
        const linked = topology.worktrees.find(
            (candidate) => candidate.rootPath === worktree.rootPath,
        );
        // A detached HEAD may hold commits no branch reaches, so the removal would refuse it anyway.
        if (!linked || linked.isMain === true || linked.branch.length === 0) return undefined;
        return {
            binding,
            branch: linked.branch,
            ownerRoot: owner.rootPath,
            rootPath: worktree.rootPath,
            worktreeProjectId: worktree.id,
        };
    }

    private async pullRequestState(
        sessionId: string,
    ): Promise<SessionPullRequestState | undefined> {
        if (!this.resolvePullRequest) return undefined;
        try {
            return (await this.resolvePullRequest(sessionId))?.value?.state;
        } catch {
            return undefined;
        }
    }

    private cancel(sessionId: string): void {
        clearTimeout(this.timers.get(sessionId));
        this.timers.delete(sessionId);
    }

    private logSkipped(sessionId: string, reason: CleanupSkipReason, startedAt: number): void {
        this.options.logger.write('info', worktreeArchiveCleanup, {
            durationMs: performance.now() - startedAt,
            fields: { outcome: 'skipped', reason, sessionId },
        });
    }

    private logFailed(sessionId: string, error: unknown, startedAt: number): void {
        this.options.logger.write('warn', worktreeArchiveCleanup, {
            durationMs: performance.now() - startedAt,
            fields: {
                // The error code only: a Git failure message can quote stderr naming the worktree's paths and refs.
                errorCode: isCaxriError(error) ? error.code : 'unknown',
                outcome: 'failed',
                sessionId,
            },
        });
    }

    /**
     * Hands this cleanup the Session pull request owner, the same late binding `ProjectStatusService` uses because
     * `SessionPullRequestService` is assembled after the Session handlers. Until then no pull request counts as
     * merged.
     */
    useSessionPullRequests(resolver: SessionPullRequestResolver): void {
        this.resolvePullRequest = resolver;
    }

    async plan(sessionId: string): Promise<SessionArchiveWorktreePlan> {
        if (!this.options.isEnabled()) return { worktree: null };
        const target = await this.findTarget(sessionId);
        if (!target) return { worktree: null };
        const pullRequestState = await this.pullRequestState(sessionId);
        return {
            worktree: {
                branch: target.branch,
                rootPath: target.rootPath,
                removal: pullRequestState === 'merged' ? 'automatic' : 'confirm',
                ...(pullRequestState && { pullRequestState }),
            },
        };
    }

    /**
     * Decides, before the Session is archived, whether its worktree goes. It has to run first: the pull request owner
     * stops tracking a Session once it is archived. Never throws, because a failed decision must not block the
     * archive.
     */
    async prepare(
        sessionId: string,
        choice: SessionArchiveWorktreeChoice | undefined,
    ): Promise<ArchivedWorktreeTarget | undefined> {
        this.cancel(sessionId);
        if (!this.options.isEnabled()) return undefined;
        const startedAt = performance.now();
        try {
            const target = await this.findTarget(sessionId);
            if (!target) return undefined;
            if (choice === 'keep') {
                this.logSkipped(sessionId, 'kept', startedAt);
                return undefined;
            }
            if (choice === 'remove') return target;
            if ((await this.pullRequestState(sessionId)) === 'merged') return target;
            this.logSkipped(sessionId, 'unmerged', startedAt);
            return undefined;
        } catch (error) {
            this.logFailed(sessionId, error, startedAt);
            return undefined;
        }
    }

    /**
     * Queues the removal of a worktree {@link prepare} chose, once the Session is archived and parked.
     */
    schedule(sessionId: string, target: ArchivedWorktreeTarget): void {
        if (this.isClosed) return;
        this.cancel(sessionId);
        const timer = setTimeout(() => {
            this.timers.delete(sessionId);
            // Fire-and-forget: `remove` logs its own failure, and `close` awaits it through `removals`.
            void this.track(this.remove(sessionId, target));
        }, this.delayMs);
        this.timers.set(sessionId, timer);
    }

    /**
     * Drops removals that have not started; a worktree whose removal never ran is simply left in place.
     */
    async close(): Promise<void> {
        this.isClosed = true;
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
        await Promise.allSettled(this.removals);
    }
}
