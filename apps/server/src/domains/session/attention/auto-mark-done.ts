import type { AppSettings, ServerEvent, SessionPullRequest, SessionRecord } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { errorLogFields, logEventCatalog } from '@caxri/system';

import type { CaxriDatabase } from '../../db';

/**
 * How often the sweep re-reads every Session. Inactivity thresholds are whole days, so a ten-minute lag is invisible; a
 * pull request closing triggers its own sweep right away.
 */
const SWEEP_INTERVAL_MS = 10 * 60_000;

/**
 * How long a triggered sweep waits for more triggers before it runs.
 */
const SWEEP_COALESCE_MS = 2_000;

const DAY_MS = 24 * 60 * 60_000;

/**
 * `agentActivity.autoMarkDoneAfterInactivity` values, in days.
 */
const INACTIVITY_DAYS = { '1d': 1, '3d': 3, '7d': 7, '14d': 14 } as const;

/**
 * Closed reason one Session was marked done automatically.
 *
 * - `pull-request-closed`: its pull request merged or closed, so the work it waited on is over.
 * - `inactive`: nothing happened in it for longer than the configured threshold.
 */
export type AutoMarkDoneReason = 'inactive' | 'pull-request-closed';

export interface AutoMarkDonePolicy {
    /**
     * Inactivity threshold in milliseconds, or `undefined` when the inactivity rule is off.
     */
    inactivityMs: number | undefined;
    isPullRequestCloseEnabled: boolean;
}

/**
 * Reads the two `agentActivity.autoMarkDone*` settings into a policy.
 */
export function autoMarkDonePolicy(
    settings: Pick<
        AppSettings,
        'agentActivity.autoMarkDoneAfterInactivity' | 'agentActivity.autoMarkDoneOnPullRequestClose'
    >,
): AutoMarkDonePolicy {
    const inactivity = settings['agentActivity.autoMarkDoneAfterInactivity'];
    return {
        inactivityMs: inactivity === 'off' ? undefined : INACTIVITY_DAYS[inactivity] * DAY_MS,
        isPullRequestCloseEnabled: settings['agentActivity.autoMarkDoneOnPullRequestClose'],
    };
}

/**
 * Why a Session's Pending Attention should be resolved automatically now, or `undefined` to leave it in Needs
 * attention.
 *
 * A Session waiting on the user (a question or permission prompt) is never settled: that is a blocked Agent, not a
 * forgotten result, and settling it would hide the one row that cannot move without the user. A running Session has
 * nothing pending to settle. A merged or closed pull request wins over inactivity so the log names the stronger cause.
 */
export function autoMarkDoneReason(
    session: Pick<
        SessionRecord,
        | 'agentActivityState'
        | 'archivedAt'
        | 'hasPendingAttention'
        | 'lastAttentionKind'
        | 'sessionActivityAt'
    >,
    pullRequestState: SessionPullRequest['state'] | undefined,
    policy: AutoMarkDonePolicy,
    now: number,
): AutoMarkDoneReason | undefined {
    if (!session.hasPendingAttention || session.archivedAt !== undefined) return undefined;
    if (session.lastAttentionKind === 'waiting' || session.agentActivityState === 'waiting')
        return undefined;
    if (session.agentActivityState === 'running') return undefined;
    if (
        policy.isPullRequestCloseEnabled &&
        (pullRequestState === 'merged' || pullRequestState === 'closed')
    )
        return 'pull-request-closed';
    if (policy.inactivityMs !== undefined && now - session.sessionActivityAt >= policy.inactivityMs)
        return 'inactive';
    return undefined;
}

export interface AutoMarkDoneOptions {
    database: Pick<CaxriDatabase, 'listVisibleSessions'> & {
        attentionMarks: Pick<CaxriDatabase['attentionMarks'], 'settle'>;
    };
    logger: Pick<StructuredLogger, 'write'>;
    now?: () => number;
    /**
     * Each Session's pull request state as last resolved in this Server Core, without a GitHub lookup.
     */
    pullRequestState(sessionId: string): SessionPullRequest['state'] | undefined;
    send(event: ServerEvent): void;
    settings(): Parameters<typeof autoMarkDonePolicy>[0];
}

/**
 * Settles Needs attention for Sessions the user has clearly moved past, the way T3 Code auto-settles finished threads:
 * a merged or closed pull request, or no activity for the configured number of days. Runs at startup, every
 * {@link SWEEP_INTERVAL_MS}, and when a Session's pull request merges or closes. Each sweep resolves in one transaction
 * and republishes the changed rows in one `state.changed` event.
 */
export class AutoMarkDone {
    private readonly timer: NodeJS.Timeout;
    private pending?: NodeJS.Timeout;
    private isDisposed = false;

    constructor(private readonly options: AutoMarkDoneOptions) {
        this.timer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
        this.timer.unref();
        // Startup: a backlog left while Server Core was down, or one that predates the setting, clears once.
        this.schedule();
    }

    /**
     * Coalesces sweeps for {@link SWEEP_COALESCE_MS}: at startup every Session's first pull request sighting arrives in
     * a burst, and one sweep covers all of them.
     */
    private schedule(): void {
        if (this.isDisposed || this.pending) return;
        this.pending = setTimeout(() => {
            this.pending = undefined;
            this.sweep();
        }, SWEEP_COALESCE_MS);
        this.pending.unref();
    }

    /**
     * Sweeps soon after a pull request settles, so the row leaves Needs attention with the merge.
     */
    observePullRequest(next: SessionPullRequest | undefined): void {
        if (next?.state === 'merged' || next?.state === 'closed') this.schedule();
    }

    sweep(): void {
        if (this.isDisposed) return;
        try {
            const policy = autoMarkDonePolicy(this.options.settings());
            if (!policy.isPullRequestCloseEnabled && policy.inactivityMs === undefined) return;
            const now = this.options.now?.() ?? Date.now();
            const entries: Array<{ attentionGeneration: number; sessionId: string }> = [];
            const reasons = new Map<string, AutoMarkDoneReason>();
            for (const session of this.options.database.listVisibleSessions()) {
                const reason = autoMarkDoneReason(
                    session,
                    this.options.pullRequestState(session.id),
                    policy,
                    now,
                );
                if (!reason) continue;
                entries.push({
                    sessionId: session.id,
                    attentionGeneration: session.attentionGeneration,
                });
                reasons.set(session.id, reason);
            }
            if (entries.length === 0) return;
            const resolved = this.options.database.attentionMarks.settle(entries);
            if (resolved.length === 0) return;
            this.options.send({
                event: 'state.changed',
                payload: { kind: 'records', sessionIds: resolved, terminalIds: [] },
            });
            const counts: Record<AutoMarkDoneReason, number> = {
                'inactive': 0,
                'pull-request-closed': 0,
            };
            for (const sessionId of resolved) counts[reasons.get(sessionId)!] += 1;
            this.options.logger.write('info', logEventCatalog.sessionAttention.autoMarkDone, {
                fields: {
                    inactive: counts.inactive,
                    pullRequestClosed: counts['pull-request-closed'],
                    resolved: resolved.length,
                },
            });
        } catch (error) {
            this.options.logger.write('warn', logEventCatalog.sessionAttention.autoMarkDoneFailed, {
                fields: errorLogFields(error),
            });
        }
    }

    dispose(): void {
        this.isDisposed = true;
        clearInterval(this.timer);
        clearTimeout(this.pending);
    }
}
