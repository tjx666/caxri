import type { SessionPullRequest } from '@caxri/protocol';
import { errorMessage } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { SessionActivityTransition } from '../agents';
import type { CaxriDatabase } from '../db';
import type { MergeNoticeOutcome, MergeNoticeRequest } from './merge-notice';

/**
 * How long Server Core waits after telling an Agent about a merge for the turn that message triggers to start. Past it,
 * an Agent that never started (stopped, or a notice that was skipped) is idle and its Session can be archived.
 */
const MERGE_NOTICE_TURN_GRACE_MS = 20_000;

/**
 * How often a deferred archive re-checks a Session whose turn ended while a background shell or subagent still runs.
 * Such work can finish without moving the Session's activity state, so the activity stream alone would never retry.
 */
const BACKGROUND_WORK_RECHECK_MS = 30_000;

/**
 * Why an archive was deferred: the Agent is mid-turn or waiting on the user, a merge-notice turn may still start, or
 * the turn ended while a background shell or subagent it started keeps working (an Agent that says "I'll watch it in
 * the background").
 */
type DeferReason = 'agent-busy' | 'background-work' | 'notice-turn';

/**
 * Closed outcome of one automatic archive decision, logged so "why did my Session disappear" and "why did it stay" both
 * have an answer.
 *
 * - `archived`: archived now.
 * - `deferred`: not archived yet, with a `reason` from {@link DeferReason}; retried on the next activity change or
 *   recheck. Logged again only when the reason changes.
 * - `disabled`: the setting was off when the decision came due.
 * - `reopened`: the pull request went back to open or draft before the archive happened.
 * - `session-gone`: the Session was deleted or already archived.
 * - `failed`: archiving threw; the Session stays where it is.
 */
export type AutoArchiveOutcome =
    'archived' | 'deferred' | 'disabled' | 'failed' | 'reopened' | 'session-gone';

export interface PullRequestSettlementOptions {
    /**
     * Archives one Session's metadata and parks its runtime; the same operation as the sidebar's Archive.
     */
    archive(sessionId: string): unknown;
    database: Pick<CaxriDatabase, 'getSession'>;
    /**
     * Tells the Desktop a Session was archived automatically, so it can say why the row left the PrimarySidebar and
     * offer Undo. Sent only after the archive succeeded.
     */
    onArchived?(sessionId: string, pullRequestState: 'closed' | 'merged'): void;
    isAutoArchiveEnabled(): boolean;
    logger: Pick<StructuredLogger, 'write'>;
    now?: () => number;
    /**
     * Sends the merge notice for a pull request merged outside the Caxri button.
     */
    notifyMerged(
        sessionId: string,
        url: string,
        request: MergeNoticeRequest,
    ): Promise<MergeNoticeOutcome>;
    /**
     * Whether the settle-time archive should wait for a Session's Agent to finish.
     */
    turnGraceMs?: number;
    /**
     * Whether a Session's Agent still has a background shell or subagent running after its turn ended.
     */
    hasBackgroundWork?(sessionId: string): boolean;
    backgroundRecheckMs?: number;
}

interface PendingArchive {
    /**
     * Archiving is not allowed before this time; cleared once the notice turn actually starts.
     */
    quietUntil: number;
    timer?: NodeJS.Timeout;
    url: string;
    /**
     * The settled state that scheduled this archive, named in the notice that follows it.
     */
    pullRequestState: 'closed' | 'merged';
    /**
     * The last logged deferral, so each distinct reason is logged once per pending archive.
     */
    deferredReason?: DeferReason;
}

function isSettled(state: SessionPullRequest['state'] | undefined): boolean {
    return state === 'merged' || state === 'closed';
}

/**
 * Reacts to a Session's pull request being merged or closed, wherever that happened: tells the Agent about a merge
 * once, then archives the Session after its Agent is idle. Only a transition Caxri watched counts (the pull request was
 * open on an earlier sweep), so starting Caxri never mass-archives old merged work.
 */
export class PullRequestSettlement {
    private readonly now: () => number;
    private readonly pending = new Map<string, PendingArchive>();

    constructor(private readonly options: PullRequestSettlementOptions) {
        this.now = options.now ?? Date.now;
    }

    private async settle(sessionId: string, pullRequest: SessionPullRequest): Promise<void> {
        let noticeOutcome: MergeNoticeOutcome | undefined;
        if (pullRequest.state === 'merged')
            noticeOutcome = await this.options.notifyMerged(sessionId, pullRequest.url, {
                origin: 'detected',
                ...(pullRequest.mergedAt !== undefined && { mergedAt: pullRequest.mergedAt }),
            });
        // A duplicate means the Project Status button already sent the notice moments ago, so its turn may be starting.
        const isStartsTurn = noticeOutcome === 'sent' || noticeOutcome === 'duplicate';
        this.pending.set(sessionId, {
            quietUntil: isStartsTurn
                ? this.now() + (this.options.turnGraceMs ?? MERGE_NOTICE_TURN_GRACE_MS)
                : 0,
            url: pullRequest.url,
            pullRequestState: pullRequest.state === 'merged' ? 'merged' : 'closed',
        });
        await this.attempt(sessionId);
    }

    private cancel(sessionId: string, outcome: AutoArchiveOutcome): void {
        const entry = this.pending.get(sessionId);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(sessionId);
        this.log(sessionId, outcome);
    }

    private async attempt(sessionId: string): Promise<void> {
        const entry = this.pending.get(sessionId);
        if (!entry) return;
        if (!this.options.isAutoArchiveEnabled()) return this.cancel(sessionId, 'disabled');
        const session = this.options.database.getSession(sessionId);
        if (!session || session.archivedAt !== undefined)
            return this.cancel(sessionId, 'session-gone');
        const isBusy =
            session.agentActivityState === 'running' || session.agentActivityState === 'waiting';
        const wait = entry.quietUntil - this.now();
        const reason: DeferReason | undefined = isBusy
            ? 'agent-busy'
            : wait > 0
              ? 'notice-turn'
              : this.options.hasBackgroundWork?.(sessionId)
                ? 'background-work'
                : undefined;
        if (reason) {
            if (entry.deferredReason !== reason) {
                entry.deferredReason = reason;
                this.log(sessionId, 'deferred', {
                    agentState: session.agentActivityState,
                    reason,
                });
            }
            clearTimeout(entry.timer);
            // A busy Agent is retried by its next activity change; the other two have no event that reliably fires.
            if (reason !== 'agent-busy') {
                entry.timer = setTimeout(
                    () => {
                        void this.attempt(sessionId);
                    },
                    reason === 'notice-turn'
                        ? wait + 1
                        : (this.options.backgroundRecheckMs ?? BACKGROUND_WORK_RECHECK_MS),
                );
                entry.timer.unref();
            }
            return;
        }
        clearTimeout(entry.timer);
        this.pending.delete(sessionId);
        try {
            await this.options.archive(sessionId);
            this.log(sessionId, 'archived');
            this.options.onArchived?.(sessionId, entry.pullRequestState);
        } catch (error) {
            this.log(sessionId, 'failed', { error: errorMessage(error, 'unknown') });
        }
    }

    private log(
        sessionId: string,
        outcome: AutoArchiveOutcome,
        fields: Record<string, string> = {},
    ): void {
        this.options.logger.write(
            outcome === 'failed' ? 'warn' : 'info',
            logEventCatalog.sessionPullRequests.autoArchive,
            { fields: { outcome, sessionId, ...fields } },
        );
    }

    /**
     * Receives each pull request change from the Session pull-request sweep.
     */
    observePullRequest(
        sessionId: string,
        previous: SessionPullRequest | undefined,
        next: SessionPullRequest | undefined,
    ): void {
        if (!previous || !next || previous.url !== next.url) return;
        if (!isSettled(previous.state) && isSettled(next.state)) {
            // Fire-and-forget: the notice logs its own outcome and the archive decision runs when it settles.
            void this.settle(sessionId, next);
            return;
        }
        if (isSettled(previous.state) && !isSettled(next.state)) this.cancel(sessionId, 'reopened');
    }

    /**
     * Receives every durable Session activity change, which is what moves a deferred archive forward.
     */
    observeActivity({ sessionId, to }: SessionActivityTransition): void {
        const entry = this.pending.get(sessionId);
        if (!entry) return;
        if (to === 'running') entry.quietUntil = 0;
        // Fire-and-forget: attempt() logs and swallows its own failures.
        void this.attempt(sessionId);
    }

    /**
     * Drops one Session's deferred archive when the Session is deleted, so its timer and entry do not outlive it.
     * Silent on purpose: the Session is gone, and a deferred archive for a busy Agent otherwise waits on an activity
     * change that never comes.
     */
    forgetSession(sessionId: string): void {
        const entry = this.pending.get(sessionId);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(sessionId);
    }

    dispose(): void {
        for (const entry of this.pending.values()) clearTimeout(entry.timer);
        this.pending.clear();
    }
}
