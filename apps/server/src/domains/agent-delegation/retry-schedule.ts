import type {
    AgentDelegationReceipt,
    DelegationRetryMode,
    DelegationRetryScheduleOutcome,
} from '@caxri/protocol';

import type { StoredAgentDelegation } from '../db';
import type { WatchHandle, WatchHub } from '../watch';
import type { RetryScheduleLogOutcome } from './diagnostics';
import { logDelegationRetrySchedule } from './diagnostics';
import {
    RETRY_SCHEDULE_MISSED_AFTER_MS,
    RETRY_SCHEDULE_POLL_MS,
    scheduleOutcomeOf,
} from './retry-schedule-time';
import { retryDelegationId } from './retry-support';
import type { AgentDelegationServiceOptions } from './service-options';

/**
 * What the schedules borrow from `DelegationRetries`, which owns the claim, the checks, and the admission.
 */
export interface RetryScheduleHost {
    options: Pick<AgentDelegationServiceOptions, 'database' | 'logger'>;
    now(): number;
    chainDepth(failed: StoredAgentDelegation): number;
    /**
     * Starts the retry from the claim the schedule holds: the same checks as Retry now, with the schedule's own claim
     * exempt. Clears the pending time once the new task is stored. Throws when it refuses.
     */
    runClaimed(failedId: string, mode: DelegationRetryMode): Promise<AgentDelegationReceipt>;
    /**
     * Gives up a claim whose task was never stored, in one save with the optional `outcome`. Does nothing for a claim
     * that is already gone and never touches a stored task.
     */
    release(failedId: string, outcome?: DelegationRetryScheduleOutcome): void;
    /**
     * Keeps the claim and drops the pending time, for a pending schedule whose task is already stored.
     */
    settle(failedId: string): void;
    /**
     * Takes the Chat usage-limit wait of the failed task's Terminal out of the way; see `claimChatWait`.
     */
    claimChatWait(failed: StoredAgentDelegation): 'cancelled' | 'none' | 'running';
    notifyRefused(failed: StoredAgentDelegation, outcome: DelegationRetryScheduleOutcome): void;
}

/**
 * Runs scheduled retries ("Retry after the limit resets"). The pending schedule is the failed task's own record: its
 * claim (`retriedAs` and the mode) plus `retryScheduledFor`, so it survives a restart and the persisted time is the one
 * deadline everything compares against. One poll through the Watch Hub, no per-schedule timer: the poll interval is the
 * most a retry starts late, and a poll that slept through the time simply finds it due.
 *
 * Each failed task is handled one at a time: {@link firing} is the single mutual exclusion for the poll, Cancel, and a
 * second poll that starts while the first is still starting a retry. A fire adds itself synchronously before its first
 * await, so Cancel either wins before it (nothing starts) or fails after it (the retry is starting). Every await is
 * followed by a fresh read; the stored record, not a snapshot, decides.
 */
export class DelegationRetrySchedules {
    private readonly firing = new Set<string>();
    private poller: WatchHandle | undefined;
    private isClosed = false;

    constructor(private readonly host: RetryScheduleHost) {}

    private get database() {
        return this.host.options.database;
    }

    private log(
        outcome: RetryScheduleLogOutcome,
        record: StoredAgentDelegation,
        extra: {
            reason?: DelegationRetryScheduleOutcome;
            lateMs?: number;
            waitMs?: number;
        } = {},
    ): void {
        logDelegationRetrySchedule(this.host.options.logger, {
            outcome,
            delegationId: record.receipt.delegationId,
            ...(record.receipt.retriedAs && { successorId: record.receipt.retriedAs }),
            ...(record.retryMode && { mode: record.retryMode }),
            provider: record.receipt.provider,
            scheduledFor: record.receipt.retryScheduledFor,
            chainDepth: this.host.chainDepth(record),
            ...extra,
        });
    }

    /**
     * The failure of the bookkeeping itself, which no refusal explains.
     */
    private refuseUnexpected(failedId: string): void {
        const current = this.database.agentDelegations.get(failedId);
        if (current?.receipt.retryScheduledFor === undefined || this.firing.has(failedId)) return;
        this.refuse(current, 'internal_error', 'refused_at_fire');
    }

    /**
     * Releases the claim with the outcome in one save and tells the Agent. Never releases a claim whose task is stored.
     */
    private refuse(
        record: StoredAgentDelegation,
        outcome: DelegationRetryScheduleOutcome,
        logOutcome: RetryScheduleLogOutcome,
        lateMs?: number,
    ): void {
        if (this.database.agentDelegations.get(record.receipt.retriedAs!)) {
            this.host.settle(record.receipt.delegationId);
            return;
        }
        this.host.release(record.receipt.delegationId, outcome);
        this.log(logOutcome, record, { reason: outcome, lateMs });
        this.host.notifyRefused(record, outcome);
    }

    private async handle(failedId: string): Promise<void> {
        // The snapshot the pass started from may be stale: another path may have cancelled or finished it since.
        const record = this.database.agentDelegations.get(failedId);
        if (record?.receipt.retryScheduledFor === undefined || !record.retryMode) return;
        const { receipt } = record;
        if (this.database.agentDelegations.get(receipt.retriedAs!)) {
            this.host.settle(failedId);
            this.log('successor_found', record);
            return;
        }
        if (this.database.getSession(receipt.sessionId)?.archivedAt !== undefined) {
            this.host.release(failedId);
            this.log('session_gone', record);
            return;
        }
        const now = this.host.now();
        const lateMs = now - receipt.retryScheduledFor!;
        if (lateMs < 0) {
            this.keepWaiting(record);
            return;
        }
        if (lateMs > RETRY_SCHEDULE_MISSED_AFTER_MS) {
            this.refuse(record, 'missed_window', 'missed_window', lateMs);
            return;
        }
        await this.fire(record, record.retryMode, lateMs);
    }

    /**
     * What a schedule that is not due yet still checks each pass, so a takeover or a competing Chat continuation ends
     * it promptly instead of leaving a pending line that cannot run.
     */
    private keepWaiting(record: StoredAgentDelegation): void {
        if (record.hasHumanIntervention) {
            this.host.release(record.receipt.delegationId, 'human_input');
            this.log('human_input_cancelled', record, { reason: 'human_input' });
            return;
        }
        if (this.host.claimChatWait(record) === 'running')
            this.refuse(record, 'target_busy', 'refused_at_fire');
    }

    private async fire(
        record: StoredAgentDelegation,
        mode: DelegationRetryMode,
        lateMs: number,
    ): Promise<void> {
        const failedId = record.receipt.delegationId;
        // Before the first await: Cancel and a second pass see the retry as starting from here on.
        this.firing.add(failedId);
        try {
            await this.host.runClaimed(failedId, mode);
            this.log('fired', record, { lateMs });
        } catch (error) {
            this.onFireError(record, error, lateMs);
        } finally {
            this.firing.delete(failedId);
        }
    }

    private onFireError(record: StoredAgentDelegation, error: unknown, lateMs: number): void {
        const failedId = record.receipt.delegationId;
        const current = this.database.agentDelegations.get(failedId);
        if (!current) {
            // Pruned or deleted while starting: there is no receipt left to write the outcome to.
            logDelegationRetrySchedule(this.host.options.logger, {
                outcome: 'record_gone',
                delegationId: failedId,
                lateMs,
            });
            return;
        }
        // The task exists even though the start threw (it then failed as a normal task): it is the next link of the
        // chain, and the claim must stay so the retry cannot start twice.
        if (this.database.agentDelegations.get(retryDelegationId(failedId))) {
            this.host.settle(failedId);
            this.log('fired', current, { lateMs });
            return;
        }
        const outcome = scheduleOutcomeOf(error);
        // The start may already have released the claim with this outcome; only a claim still held is released here.
        if (current.receipt.retriedAs) this.host.release(failedId, outcome);
        this.log('refused_at_fire', record, { reason: outcome, lateMs });
        this.host.notifyRefused(record, outcome);
    }

    /**
     * Records a schedule that was just claimed.
     */
    scheduled(record: StoredAgentDelegation): void {
        this.log('scheduled', record, {
            waitMs: record.receipt.retryScheduledFor! - this.host.now(),
        });
    }

    /**
     * `agent.delegation.cancelScheduledRetry`: releases a pending schedule. False when nothing is pending, when the
     * retry is already starting (the poll won), and when its task is already stored (it started).
     */
    cancel(failedId: string): boolean {
        if (this.firing.has(failedId)) return false;
        const current = this.database.agentDelegations.get(failedId);
        if (current?.receipt.retryScheduledFor === undefined) return false;
        if (this.database.agentDelegations.get(current.receipt.retriedAs!)) {
            this.host.settle(failedId);
            return false;
        }
        this.host.release(failedId);
        this.log('cancelled', current);
        return true;
    }

    /**
     * Starts the poll, once everything the retries depend on is composed: a schedule that is due at startup needs the
     * live Endpoint generations and Chat services, which are not ready earlier. Runs one pass at once and then every
     * {@link RETRY_SCHEDULE_POLL_MS}. Logs the schedules found, once per start.
     */
    start(watchHub: Pick<WatchHub, 'registerPoller'>, intervalMs = RETRY_SCHEDULE_POLL_MS): void {
        const pending = this.database.agentDelegations.scheduledRetries();
        if (pending.length > 0) {
            const now = this.host.now();
            logDelegationRetrySchedule(this.host.options.logger, {
                outcome: 'restored',
                pending: pending.length,
                overdue: pending.filter((record) => record.receipt.retryScheduledFor! <= now)
                    .length,
            });
        }
        this.poller = watchHub.registerPoller({
            intervalMs,
            label: 'delegation-retry-schedules',
            pollOnce: () => this.drain(),
        });
        void this.drain();
    }

    /**
     * One pass over the pending schedules, oldest first. A schedule that throws is recorded as its own refusal and
     * never stops the next one; a pass still waiting on a start does not hold up the next pass, which skips that
     * schedule.
     */
    async drain(): Promise<void> {
        for (const { receipt } of this.database.agentDelegations.scheduledRetries()) {
            if (this.isClosed) return;
            if (this.firing.has(receipt.delegationId)) continue;
            try {
                // react-doctor-disable-next-line react-doctor/async-await-in-loop -- one provider start at a time
                await this.handle(receipt.delegationId); // eslint-disable-line no-await-in-loop -- one provider start at a time
            } catch {
                this.refuseUnexpected(receipt.delegationId);
            }
        }
    }

    async close(): Promise<void> {
        this.isClosed = true;
        await this.poller?.dispose();
        this.poller = undefined;
    }
}
