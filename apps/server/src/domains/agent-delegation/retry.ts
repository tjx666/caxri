import type {
    AgentDelegationCreate,
    AgentDelegationReceipt,
    AgentProvider,
    DelegationRetryMode,
    DelegationRetryOption,
    DelegationRetryReply,
    DelegationRetrySchedule,
} from '@caxri/protocol';
import { CaxriError, isDelegationActive, isRetryableDelegationFailure } from '@caxri/protocol';
import { SingleFlight } from '@caxri/system';

import type { StoredAgentDelegation } from '../db';
import type { WatchHub } from '../watch';
import type { DelegationAuthority } from './admission';
import { isCaxriBotCaller } from './admission';
import { logDelegationRetry } from './diagnostics';
import { resumeRejection } from './rejection';
import { RetryClaims } from './retry-claims';
import { startFreshRetry } from './retry-fresh';
import { createRetryNotice, createRetryRefusedNotice } from './retry-notice';
import { DelegationRetrySchedules } from './retry-schedule';
import { scheduledRetryTime, scheduleOutcomeOf } from './retry-schedule-time';
import type { Reason, RetryAdmission, VerifiedWorktree } from './retry-support';
import {
    RESUME_REASONS,
    retryDelegationId,
    RetryRefused,
    verifyRetryWorktree,
} from './retry-support';
import { retrySwitchTargets } from './retry-switch';
import type { AgentDelegationServiceOptions, DelegationWorktree } from './service-options';

/**
 * What a retry borrows from the delegation service.
 */
export interface DelegationRetryHost {
    options: AgentDelegationServiceOptions;
    now(): number;
    save(record: StoredAgentDelegation, isAnnounced?: boolean): StoredAgentDelegation;
    hasActiveTask(terminalId: string): boolean;
    /**
     * `createInSession` as the failed task's own authority.
     */
    admit(
        id: string,
        authority: DelegationAuthority,
        input: AgentDelegationCreate,
        isNewSession: boolean,
        retry: RetryAdmission,
    ): Promise<AgentDelegationReceipt>;
}

/**
 * A claim just made: the failed task as saved, the new task's ID, and the worktree a fresh retry binds.
 */
interface ClaimedRetry {
    failed: StoredAgentDelegation;
    retryId: string;
    worktree?: DelegationWorktree;
}

/**
 * Owner-only retry of a failed delegated task (`agent.delegation.retry`), now or at the provider's reset. The retry
 * runs as the Agent that delegated the failed task, with that task's stored principal and caller Terminal, so the Agent
 * can still `wait` on and read the new task; the owner's own identity would orphan it.
 *
 * Everything up to and including the claim is synchronous (read, checks, save, with no await between), like the
 * follow-up chain claim. The claim is `retriedAs` on the failed task's receipt plus the persisted `retryMode`, and it
 * is what lets only one retry through whichever button was clicked. A scheduled retry holds the same claim from the
 * moment it is scheduled and marks it pending with `retryScheduledFor` ({@link DelegationRetrySchedules}). The claim is
 * released when admission refuses the retry before the new record exists, and at Server startup when it names a task
 * that was never stored and is not a pending schedule.
 */
export class DelegationRetries {
    private readonly claims: RetryClaims;
    private readonly flights = new SingleFlight<string, DelegationRetryReply>();
    private readonly notify;
    private readonly notifyRefusedCaller;
    private readonly schedules: DelegationRetrySchedules;

    constructor(private readonly host: DelegationRetryHost) {
        this.claims = new RetryClaims(host);
        this.notify = createRetryNotice(host.options, (failed) => this.isCallerLive(failed));
        this.notifyRefusedCaller = createRetryRefusedNotice(host.options, (failed) =>
            this.isCallerLive(failed),
        );
        this.schedules = new DelegationRetrySchedules({
            options: host.options,
            now: () => host.now(),
            chainDepth: (failed) => this.claims.chainDepth(failed),
            runClaimed: (failedId, mode) => this.runClaimed(failedId, mode),
            release: (failedId, outcome) => this.claims.releaseUnstored(failedId, outcome),
            settle: (failedId) => this.claims.settlePending(failedId),
            claimChatWait: (failed) => this.claimChatWait(failed),
            notifyRefused: (failed, outcome) => {
                this.notifyRefusedCaller(failed, outcome);
            },
        });
    }

    private get database() {
        return this.host.options.database;
    }

    /**
     * Whether the Agent that delegated `failed` can still read a task retried on its behalf. An Agent must be the live
     * Endpoint generation of its Terminal, because ownership compares the stored principal including its generation (a
     * live Terminal alone proves nothing). Caxri Bot keeps its ledger across generations and only needs its Terminal.
     * The owner's own tasks (Desktop, CLI) have no Agent to outlive.
     */
    private isCallerLive(failed: StoredAgentDelegation): boolean {
        const { principal } = failed;
        if (principal.kind === 'desktop' || principal.kind === 'human-cli') return true;
        const terminalId = failed.receipt.callerTerminalId;
        if (!terminalId || principal.kind !== 'agent') return false;
        if (!this.database.getTerminal(terminalId)) return false;
        if (isCaxriBotCaller(this.database, { principal, callerTerminalId: terminalId }))
            return true;
        const endpoint = this.host.options.callerEndpoint?.(terminalId);
        return (
            endpoint !== undefined &&
            principal.endpointId === endpoint.endpointId &&
            principal.generation === endpoint.generation &&
            principal.id === `agent:${endpoint.endpointId}`
        );
    }

    /**
     * The mode-independent reasons a failed task cannot be retried. `isOwnClaim` is the scheduled retry's own claim at
     * fire time, which is the only claim that does not count as already retried.
     */
    private commonRefusal(failed: StoredAgentDelegation, isOwnClaim: boolean): Reason | undefined {
        if (!isOwnClaim && failed.receipt.retriedAs) return 'already_retried';
        if (isDelegationActive(failed.receipt) || !isRetryableDelegationFailure(failed.receipt))
            return 'not_retryable';
        if (failed.hasHumanIntervention) return 'human_input';
        // Someone already followed this task up; it is no longer the end of its chain.
        if (failed.nextDelegationId) return 'not_retryable';
        const { kind } = failed.principal;
        if (kind !== 'agent' && kind !== 'desktop' && kind !== 'human-cli') return 'not_retryable';
        return this.isCallerLive(failed) ? undefined : 'caller_gone';
    }

    private freshRefusal(failed: StoredAgentDelegation): Reason | undefined {
        const { database } = this;
        if (!this.host.options.newSessions || !database.getSession(failed.receipt.sessionId))
            return 'not_retryable';
        if (database.caxriBotRows()?.sessionIds.includes(failed.receipt.sessionId))
            return 'not_retryable';
        const binding = database.getSessionWorkbenchBinding(failed.receipt.sessionId);
        if (!binding) return 'not_retryable';
        return binding.workbenchRootProjectId !== binding.projectId &&
            !database.getProject(binding.workbenchRootProjectId)
            ? 'worktree_gone'
            : undefined;
    }

    private refusal(
        failed: StoredAgentDelegation,
        mode: DelegationRetryMode,
        isOwnClaim = false,
    ): Reason | undefined {
        const common = this.commonRefusal(failed, isOwnClaim);
        if (common) return common;
        if (mode === 'fresh') return this.freshRefusal(failed);
        const rejection = resumeRejection(
            failed,
            this.host.options,
            (terminalId) => this.host.hasActiveTask(terminalId),
            isOwnClaim ? retryDelegationId(failed.receipt.delegationId) : undefined,
        );
        return rejection && RESUME_REASONS[rejection];
    }

    private async optionFor(
        failed: StoredAgentDelegation,
        mode: DelegationRetryMode,
    ): Promise<DelegationRetryOption> {
        let reason = this.refusal(failed, mode);
        if (!reason && mode === 'fresh') {
            try {
                await verifyRetryWorktree(this.database, failed);
            } catch {
                reason = 'worktree_gone';
            }
        }
        return {
            mode,
            provider: failed.receipt.provider,
            available: !reason,
            ...(reason && { unavailableReason: reason }),
        };
    }

    private log(
        failed: StoredAgentDelegation,
        mode: DelegationRetryMode,
        outcome: 'refused' | 'shared' | 'started',
        retryId?: string,
        reason?: Reason | 'other',
        toProvider?: AgentProvider,
    ): void {
        logDelegationRetry(this.host.options.logger, {
            delegationId: failed.receipt.delegationId,
            retryId,
            mode,
            failure: failed.receipt.failure,
            outcome,
            reason,
            // A refusal names the requested target; only a shared or started retry falls back to the claimed one.
            toProvider: outcome === 'refused' ? toProvider : (toProvider ?? failed.retryProvider),
            chainDepth: this.claims.chainDepth(failed),
        });
    }

    private refused(
        failed: StoredAgentDelegation,
        mode: DelegationRetryMode,
        reason: Reason,
        toProvider?: AgentProvider,
    ): RetryRefused {
        this.log(failed, mode, 'refused', undefined, reason, toProvider);
        return new RetryRefused(reason);
    }

    /**
     * Makes this retry the only continuation of the failed turn. The failed task's Chat may be waiting to continue on
     * its own after a usage limit (`agentChat.autoContinueAtUsageLimit`), which would run the same work a second time:
     * a wait that has not started is cancelled, one that is already continuing wins.
     */
    private claimChatWait(failed: StoredAgentDelegation): 'cancelled' | 'none' | 'running' {
        const { terminalId } = failed.receipt;
        if (!terminalId) return 'none';
        return this.host.options.claimChatUsageLimitWait?.(terminalId) ?? 'none';
    }

    /**
     * Everything that must hold before a claim, now or at a scheduled fire: the checks, the proof that a fresh retry's
     * worktree is still the directory it was bound to, and the checks again after that await, because everything may
     * have changed during the filesystem check, including another mode's claim.
     */
    private async checked(
        failedId: string,
        mode: DelegationRetryMode,
        isOwnClaim: boolean,
        switchTo?: AgentProvider,
    ): Promise<{ failed: StoredAgentDelegation; verified?: VerifiedWorktree }> {
        const assertRetryable = (record: StoredAgentDelegation) => {
            const reason = this.refusal(record, mode, isOwnClaim);
            if (reason) throw this.refused(record, mode, reason, switchTo);
        };
        let failed = this.claims.load(failedId);
        assertRetryable(failed);
        if (mode !== 'fresh') return { failed };
        let verified: VerifiedWorktree;
        try {
            verified = await verifyRetryWorktree(this.database, failed);
        } catch {
            throw this.refused(failed, mode, 'worktree_gone', switchTo);
        }
        // Awaited before the reload below, like the worktree proof, so the checks after it see the settled state.
        if (
            switchTo &&
            !(await retrySwitchTargets(this.host.options, failed.receipt.provider)).includes(
                switchTo,
            )
        )
            throw this.refused(failed, mode, 'not_retryable', switchTo);
        failed = this.claims.load(failedId);
        assertRetryable(failed);
        if (
            verified.binding !==
            JSON.stringify(this.database.getSessionWorkbenchBinding(failed.receipt.sessionId))
        )
            throw this.refused(failed, mode, 'worktree_gone', switchTo);
        return { failed, verified };
    }

    /**
     * Claims the failed task for a retry: now, or pending until the provider's reset (`isScheduled`).
     */
    private async claim(
        failedId: string,
        mode: DelegationRetryMode,
        isScheduled: boolean,
        switchTo?: AgentProvider,
    ): Promise<ClaimedRetry> {
        const { failed: checkedTask, verified } = await this.checked(
            failedId,
            mode,
            false,
            switchTo,
        );
        let failed = checkedTask;
        const scheduledFor = isScheduled
            ? scheduledRetryTime(failed.receipt, this.host.now())
            : undefined;
        if (isScheduled && scheduledFor === undefined)
            throw this.refused(failed, mode, 'no_reset_time');
        if (this.claimChatWait(failed) === 'running')
            throw this.refused(failed, mode, 'target_busy', switchTo);
        const retryId = retryDelegationId(failedId);
        failed = this.host.save({
            ...failed,
            receipt: {
                ...failed.receipt,
                retriedAs: retryId,
                retryScheduledFor: scheduledFor,
                retryScheduleOutcome: undefined,
            },
            retryMode: mode,
            retryProvider: switchTo,
        });
        return { failed, retryId, worktree: verified?.worktree };
    }

    private async run(
        failedId: string,
        mode: DelegationRetryMode,
        switchTo?: AgentProvider,
    ): Promise<AgentDelegationReceipt> {
        const failed = this.claims.load(failedId);
        const existing = failed.receipt.retriedAs
            ? this.database.agentDelegations.get(failed.receipt.retriedAs)
            : undefined;
        if (existing) {
            if (failed.retryMode !== mode || failed.retryProvider !== switchTo)
                throw this.refused(failed, mode, 'already_retried', switchTo);
            this.log(failed, mode, 'shared', existing.receipt.delegationId);
            return existing.receipt;
        }
        // A claim with no stored task and no run in flight was cut off before the insert.
        if (failed.receipt.retriedAs) this.claims.release(failedId);
        const claimed = await this.claim(failedId, mode, false, switchTo);
        return this.admit(claimed.failed, mode, claimed.retryId, claimed.worktree);
    }

    private async schedule(
        failedId: string,
        mode: DelegationRetryMode,
    ): Promise<DelegationRetryReply> {
        const failed = this.claims.load(failedId);
        // Startup already released every claim a crash cut off, so a claim held now is a started retry or one still
        // being admitted: releasing it here would schedule a retry that is already running.
        if (failed.receipt.retriedAs) throw this.refused(failed, mode, 'already_retried');
        const { failed: pending } = await this.claim(failedId, mode, true);
        this.schedules.scheduled(pending);
        return {
            status: 'scheduled',
            delegationId: failedId,
            scheduledFor: pending.receipt.retryScheduledFor!,
        };
    }

    /**
     * Starts the retry a schedule holds the claim for, once its time has come. The claim stays held throughout and the
     * pending time is dropped only after the new task is stored (`admit`), so a crash in between leaves a schedule the
     * next start finds again, with the deterministic task ID telling whether the task was stored.
     */
    private async runClaimed(
        failedId: string,
        mode: DelegationRetryMode,
    ): Promise<AgentDelegationReceipt> {
        const retryId = retryDelegationId(failedId);
        const isPending = (record: StoredAgentDelegation) =>
            record.receipt.retriedAs === retryId &&
            record.receipt.retryScheduledFor !== undefined &&
            record.retryMode === mode;
        if (!isPending(this.claims.load(failedId)))
            throw new CaxriError('CONFLICT', 'No scheduled retry is pending');
        const { failed, verified } = await this.checked(failedId, mode, true);
        if (!isPending(failed)) throw new CaxriError('CONFLICT', 'No scheduled retry is pending');
        if (this.claimChatWait(failed) === 'running')
            throw this.refused(failed, mode, 'target_busy');
        return this.admit(failed, mode, retryId, verified?.worktree);
    }

    private async admit(
        failed: StoredAgentDelegation,
        mode: DelegationRetryMode,
        retryId: string,
        worktree: DelegationWorktree | undefined,
    ): Promise<AgentDelegationReceipt> {
        const failedId = failed.receipt.delegationId;
        const authority: DelegationAuthority = {
            principal: failed.principal,
            callerTerminalId: failed.receipt.callerTerminalId,
        };
        const retry: RetryAdmission = {
            retryOf: failedId,
            provider: failed.retryProvider ?? failed.receipt.provider,
            inherited: {
                depth: failed.receipt.depth,
                parentDelegationId: failed.receipt.parentDelegationId,
                callerTurnId: failed.callerTurnId,
                callerLaunchId: failed.callerLaunchId,
            },
            guard: () => {
                if (!this.isCallerLive(this.claims.load(failedId)))
                    throw new RetryRefused('caller_gone');
            },
        };
        try {
            const receipt =
                mode === 'resume'
                    ? await this.host.admit(
                          retryId,
                          authority,
                          {
                              projectId: failed.input.projectId,
                              prompt: failed.input.prompt,
                              callerProvider: failed.input.callerProvider,
                              sessionId: failed.receipt.sessionId,
                              resumeFrom: failedId,
                          },
                          false,
                          retry,
                      )
                    : await startFreshRetry(this.host, failed, retryId, authority, retry, worktree);
            this.claims.settlePending(failedId);
            this.log(failed, mode, 'started', retryId);
            this.notify(failed, retryId);
            return receipt;
        } catch (error) {
            if (this.database.agentDelegations.get(retryId)) {
                // Kept once the task exists, even if it then failed: it is the next link of the chain.
                this.claims.settlePending(failedId);
                this.notify(failed, retryId);
            } else {
                // A scheduled retry records why in the same save that releases its claim.
                if (this.database.agentDelegations.get(failedId))
                    this.claims.release(
                        failedId,
                        true,
                        failed.receipt.retryScheduledFor === undefined
                            ? undefined
                            : scheduleOutcomeOf(error),
                    );
                this.log(
                    failed,
                    mode,
                    'refused',
                    undefined,
                    error instanceof RetryRefused ? error.reason : 'other',
                );
            }
            throw error;
        }
    }

    /**
     * `agent.delegation.retryOptions`: which modes could run now, whether a retry could be scheduled for the provider's
     * reset, and the other Agents a fresh retry could switch to. A read; it claims nothing.
     */
    async options(failedId: string): Promise<{
        options: DelegationRetryOption[];
        schedule: DelegationRetrySchedule;
        switchTargets: AgentProvider[];
    }> {
        const failed = this.claims.load(failedId);
        const scheduledFor = failed.receipt.retryScheduledFor;
        if (scheduledFor !== undefined) {
            /**
             * The pending schedule holds the claim: no other retry runs until it is cancelled.
             */
            const blocked = (mode: DelegationRetryMode): DelegationRetryOption => ({
                mode,
                provider: failed.receipt.provider,
                available: false,
                unavailableReason: 'schedule_pending',
            });
            return {
                options: [blocked('resume'), blocked('fresh')],
                schedule: { available: false, scheduledFor, unavailableReason: 'schedule_pending' },
                switchTargets: [],
            };
        }
        const options = [
            await this.optionFor(failed, 'resume'),
            await this.optionFor(failed, 'fresh'),
        ];
        const time = scheduledRetryTime(failed.receipt, this.host.now());
        const isOpen = options.some((option) => option.available);
        return {
            options,
            switchTargets: options[1].available
                ? await retrySwitchTargets(this.host.options, failed.receipt.provider)
                : [],
            schedule:
                time !== undefined && isOpen
                    ? { available: true, scheduledFor: time }
                    : {
                          available: false,
                          unavailableReason:
                              time === undefined ? 'no_reset_time' : options[0].unavailableReason,
                      },
        };
    }

    /**
     * `agent.delegation.retry`. The same request again returns the task it started or the schedule it holds (also after
     * the task finished); any other request for the failed task is refused, a pending schedule included: cancel it
     * first. Concurrent identical requests share one run.
     */
    async retry(
        failedId: string,
        mode: DelegationRetryMode,
        scheduleAt?: 'reset',
        provider?: AgentProvider,
    ): Promise<DelegationRetryReply> {
        const failed = this.claims.load(failedId);
        // A switch only exists for an immediate fresh retry; the protocol schema enforces it, this guards other callers.
        if (provider && (mode !== 'fresh' || scheduleAt))
            throw this.refused(failed, mode, 'not_retryable', provider);
        // Naming the failed task's own Agent is no switch: it would silently drop the model it ran with.
        if (provider === failed.receipt.provider)
            throw this.refused(failed, mode, 'not_retryable', provider);
        const pendingFor = failed.receipt.retryScheduledFor;
        // Before any dangling-claim cleanup: a pending schedule is a claim that is meant to have no task yet.
        if (pendingFor !== undefined) {
            if (scheduleAt && failed.retryMode === mode)
                return { status: 'scheduled', delegationId: failedId, scheduledFor: pendingFor };
            throw this.refused(failed, mode, 'schedule_pending');
        }
        // Before the fingerprint check inside admission: another mode or target Agent is a conflict, never a shared run.
        if (
            failed.receipt.retriedAs &&
            (failed.retryMode !== mode || failed.retryProvider !== provider)
        )
            throw this.refused(failed, mode, 'already_retried', provider);
        return this.flights.run(
            `${failedId}\0${mode}\0${scheduleAt ?? 'now'}\0${provider ?? ''}`,
            async () => {
                if (scheduleAt) return this.schedule(failedId, mode);
                const receipt = await this.run(failedId, mode, provider);
                return {
                    status: 'started' as const,
                    delegationId: receipt.delegationId,
                    sessionId: receipt.sessionId,
                };
            },
        );
    }

    /**
     * `agent.delegation.cancelScheduledRetry`.
     */
    cancelScheduled(failedId: string): { cancelled: boolean } {
        this.claims.load(failedId);
        return { cancelled: this.schedules.cancel(failedId) };
    }

    /**
     * Starts the scheduled-retry poll once the Server is fully composed.
     */
    startSchedules(watchHub: Pick<WatchHub, 'registerPoller'>, intervalMs?: number): void {
        this.schedules.start(watchHub, intervalMs);
    }

    /**
     * Runs one pass over the pending schedules now; the poll does this on its own.
     */
    drainSchedules(): Promise<void> {
        return this.schedules.drain();
    }

    closeSchedules(): Promise<void> {
        return this.schedules.close();
    }

    /**
     * Startup recovery of the claims a restart cut off. A claim without a stored task is a crash between the claim and
     * the insert; nothing was started, so the failed task becomes retryable again, silently like the rest of startup
     * recovery. A pending schedule is kept, because its task is not meant to exist yet; if its task is stored, the
     * crash came after the insert and only the pending time is dropped, so it is never started twice.
     */
    recoverClaims(): void {
        for (const record of this.database.agentDelegations.all()) {
            const { retriedAs, retryScheduledFor, delegationId } = record.receipt;
            if (!retriedAs) continue;
            if (this.database.agentDelegations.get(retriedAs))
                this.claims.settlePending(delegationId, false);
            else if (retryScheduledFor === undefined) this.claims.release(delegationId, false);
        }
    }
}
