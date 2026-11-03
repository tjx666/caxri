import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';

import type {
    AgentDelegationCreate,
    AgentDelegationReceipt,
    AgentProvider,
    DelegationRetryMode,
    DelegationRetryOption,
    DelegationRetryUnavailableReason,
} from '@caxri/protocol';
import { CaxriError, isDelegationActive, isRetryableDelegationFailure } from '@caxri/protocol';
import { SingleFlight } from '@caxri/system';

import type { StoredAgentDelegation } from '../db';
import type { DelegationAuthority } from './admission';
import { isCaxriBotCaller } from './admission';
import { logDelegationRetry } from './diagnostics';
import type { DelegationResumeRejection } from './rejection';
import { resumeRejection } from './rejection';
import { createRetryNotice } from './retry-notice';
import type { AgentDelegationServiceOptions, DelegationWorktree } from './service-options';

type Reason = DelegationRetryUnavailableReason;

/**
 * What a retry adds to ordinary admission (`createInSession`): the link back, the failed task's provider to hold to,
 * the tree position to keep, and the recheck of its caller.
 */
export interface RetryAdmission {
    retryOf: string;
    /**
     * A retry never switches provider; a current setting that now resolves elsewhere is refused.
     */
    provider: AgentProvider;
    inherited: Pick<AgentDelegationReceipt, 'depth' | 'parentDelegationId'> & {
        callerTurnId?: string;
    };
    /**
     * Throws unless the delegating Agent is still the live generation that can read the new task. Called after every
     * await that precedes an irreversible step.
     */
    guard(): void;
}

/**
 * What a retry borrows from the delegation service.
 */
export interface DelegationRetryHost {
    options: AgentDelegationServiceOptions;
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
 * A retry refused for a reason a Client words itself; see `delegationRetryUnavailableReasonSchema`.
 */
export class RetryRefused extends CaxriError {
    constructor(readonly reason: Reason) {
        super('CONFLICT', `Delegated task cannot be retried: ${reason}`, { reason });
    }
}

/**
 * Resume refusals as the reason a Client shows. The wording differs from the failure a refused follow-up records, so
 * this is its own table; a task with no conversation to resume reads as `no_provider_session`.
 */
const RESUME_REASONS = {
    no_terminal: 'no_provider_session',
    no_provider_session: 'no_provider_session',
    provider_session_replaced: 'session_changed',
    parent_chained: 'target_busy',
    terminal_busy: 'target_busy',
    target_lost: 'target_changed',
    launch_replaced: 'target_changed',
    human_intervened: 'human_input',
    no_input_epoch: 'human_input',
    input_epoch_moved: 'human_input',
    parent_human_intervened: 'human_input',
    resume_unsupported: 'resume_unsupported',
} as const satisfies Record<DelegationResumeRejection, Reason>;

/**
 * The new task's ID, derived from the failed task's alone. It must not depend on the mode, so two buttons racing for
 * one failed task name the same ID. UUID-shaped because task IDs name private directories (`prepareDelegationLaunch`).
 */
export function retryDelegationId(failedId: string): string {
    const hex = createHash('sha256').update(`retry\0${failedId}`).digest('hex');
    return [
        hex.slice(0, 8),
        hex.slice(8, 12),
        hex.slice(12, 16),
        hex.slice(16, 20),
        hex.slice(20, 32),
    ].join('-');
}

/**
 * A retry never switches provider. A fresh retry resolves its launch from the current settings, which can now name
 * another provider for the same preset.
 */
export function assertRetryProvider(
    retry: RetryAdmission | undefined,
    selection: { provider: AgentProvider },
): void {
    if (retry && retry.provider !== selection.provider) throw new RetryRefused('not_retryable');
}

interface VerifiedWorktree {
    /**
     * The linked worktree to bind, absent when the failed Session ran in its Project's own root.
     */
    worktree?: DelegationWorktree;
    /**
     * The Session's binding as read before the filesystem check, to compare with the binding afterwards.
     */
    binding: string;
}

/**
 * Owner-only "retry now" of a failed delegated task (`agent.delegation.retry`). The retry runs as the Agent that
 * delegated the failed task, with that task's stored principal and caller Terminal, so the Agent can still `wait` on
 * and read the new task; the owner's own identity would orphan it.
 *
 * Everything up to and including the claim is synchronous (read, checks, save, with no await between), like the
 * follow-up chain claim. The claim is `retriedAs` on the failed task's receipt plus the persisted `retryMode`, and it
 * is what lets only one retry through whichever button was clicked. It is released when admission refuses the retry
 * before the new record exists, and at Server startup when it names a task that was never stored.
 */
export class DelegationRetries {
    private readonly flights = new SingleFlight<string, AgentDelegationReceipt>();
    private readonly notify;

    constructor(private readonly host: DelegationRetryHost) {
        this.notify = createRetryNotice(host.options, (failed) => this.isCallerLive(failed));
    }

    private get database() {
        return this.host.options.database;
    }

    private load(id: string): StoredAgentDelegation {
        const record = this.database.agentDelegations.get(id);
        if (!record) throw new CaxriError('NOT_FOUND', 'Delegation is unavailable');
        return record;
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
     * The mode-independent reasons a failed task cannot be retried.
     */
    private commonRefusal(failed: StoredAgentDelegation): Reason | undefined {
        if (failed.receipt.retriedAs) return 'already_retried';
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

    private refusal(failed: StoredAgentDelegation, mode: DelegationRetryMode): Reason | undefined {
        const common = this.commonRefusal(failed);
        if (common) return common;
        if (mode === 'fresh') return this.freshRefusal(failed);
        const rejection = resumeRejection(failed, this.host.options, (terminalId) =>
            this.host.hasActiveTask(terminalId),
        );
        return rejection && RESUME_REASONS[rejection];
    }

    /**
     * The linked worktree a fresh retry must reuse, proven to still be the directory it was bound to. Never falls back
     * to the Project root, which would be the wrong working directory. Asynchronous: the caller rechecks everything
     * synchronously afterwards.
     */
    private async verifyWorktree(failed: StoredAgentDelegation): Promise<VerifiedWorktree> {
        const binding = this.database.getSessionWorkbenchBinding(failed.receipt.sessionId);
        const key = JSON.stringify(binding);
        if (!binding || binding.workbenchRootProjectId === binding.projectId)
            return { binding: key };
        const project = this.database.getProject(binding.workbenchRootProjectId);
        if (!project || !binding.rootInode) throw new RetryRefused('worktree_gone');
        try {
            const stats = await lstat(project.rootPath, { bigint: true });
            if (
                stats.isSymbolicLink() ||
                !stats.isDirectory() ||
                stats.ino.toString() !== binding.rootInode
            )
                throw new RetryRefused('worktree_gone');
            return {
                binding: key,
                worktree: {
                    projectId: binding.workbenchRootProjectId,
                    identity: { device: stats.dev.toString(), inode: stats.ino.toString() },
                },
            };
        } catch {
            throw new RetryRefused('worktree_gone');
        }
    }

    private async optionFor(
        failed: StoredAgentDelegation,
        mode: DelegationRetryMode,
    ): Promise<DelegationRetryOption> {
        let reason = this.refusal(failed, mode);
        if (!reason && mode === 'fresh') {
            try {
                await this.verifyWorktree(failed);
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
    ): void {
        logDelegationRetry(this.host.options.logger, {
            delegationId: failed.receipt.delegationId,
            retryId,
            mode,
            failure: failed.receipt.failure,
            outcome,
            reason,
            chainDepth: this.chainDepth(failed),
        });
    }

    private refused(
        failed: StoredAgentDelegation,
        mode: DelegationRetryMode,
        reason: Reason,
    ): RetryRefused {
        this.log(failed, mode, 'refused', undefined, reason);
        return new RetryRefused(reason);
    }

    private chainDepth(failed: StoredAgentDelegation): number {
        let depth = 0;
        let current: StoredAgentDelegation | undefined = failed;
        while (current?.receipt.retryOf && depth < 32) {
            depth++;
            current = this.database.agentDelegations.get(current.receipt.retryOf);
        }
        return depth;
    }

    /**
     * Clears a claim whose task was never stored. Reads the stored record, which other saves may have moved on.
     */
    private releaseClaim(failedId: string, isAnnounced = true): StoredAgentDelegation {
        const current = this.load(failedId);
        return this.host.save(
            {
                ...current,
                retryMode: undefined,
                receipt: { ...current.receipt, retriedAs: undefined },
            },
            isAnnounced,
        );
    }

    private async run(
        failedId: string,
        mode: DelegationRetryMode,
    ): Promise<AgentDelegationReceipt> {
        let failed = this.load(failedId);
        const existing = failed.receipt.retriedAs
            ? this.database.agentDelegations.get(failed.receipt.retriedAs)
            : undefined;
        if (existing) {
            if (failed.retryMode !== mode) throw this.refused(failed, mode, 'already_retried');
            this.log(failed, mode, 'shared', existing.receipt.delegationId);
            return existing.receipt;
        }
        // A claim with no stored task and no run in flight was cut off before the insert.
        if (failed.receipt.retriedAs) failed = this.releaseClaim(failedId);
        const assertRetryable = (record: StoredAgentDelegation) => {
            const reason = this.refusal(record, mode);
            if (reason) throw this.refused(record, mode, reason);
        };
        let verified: VerifiedWorktree | undefined;
        assertRetryable(failed);
        if (mode === 'fresh') {
            try {
                verified = await this.verifyWorktree(failed);
            } catch {
                throw this.refused(failed, mode, 'worktree_gone');
            }
            // Everything may have changed during the filesystem check, including another mode's claim.
            failed = this.load(failedId);
            assertRetryable(failed);
            if (
                verified.binding !==
                JSON.stringify(this.database.getSessionWorkbenchBinding(failed.receipt.sessionId))
            )
                throw this.refused(failed, mode, 'worktree_gone');
        }
        const retryId = retryDelegationId(failedId);
        failed = this.host.save({
            ...failed,
            receipt: { ...failed.receipt, retriedAs: retryId },
            retryMode: mode,
        });
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
            provider: failed.receipt.provider,
            inherited: {
                depth: failed.receipt.depth,
                parentDelegationId: failed.receipt.parentDelegationId,
                callerTurnId: failed.callerTurnId,
            },
            guard: () => {
                if (!this.isCallerLive(this.load(failedId))) throw new RetryRefused('caller_gone');
            },
        };
        const { selection } = failed.receipt;
        const base = {
            projectId: failed.input.projectId,
            prompt: failed.input.prompt,
            callerProvider: failed.input.callerProvider,
        };
        try {
            const receipt =
                mode === 'resume'
                    ? await this.host.admit(
                          retryId,
                          authority,
                          { ...base, sessionId: failed.receipt.sessionId, resumeFrom: failedId },
                          false,
                          retry,
                      )
                    : await this.startFresh(
                          retryId,
                          authority,
                          retry,
                          {
                              ...base,
                              ...(selection?.preset
                                  ? { preset: selection.preset }
                                  : {
                                        provider: failed.receipt.provider,
                                        model: selection?.model,
                                        effort: selection?.effort,
                                    }),
                              ...(failed.input.handoff && { handoff: true as const }),
                              ...(failed.input.consult && { consult: true as const }),
                          },
                          worktree,
                      );
            this.log(failed, mode, 'started', retryId);
            this.notify(failed, retryId);
            return receipt;
        } catch (error) {
            if (this.database.agentDelegations.get(retryId)) {
                // Kept once the task exists, even if it then failed: it is the next link of the chain.
                this.notify(failed, retryId);
            } else {
                if (this.database.agentDelegations.get(failedId)) this.releaseClaim(failedId);
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
     * A new Session on the failed task's workbench root: it carries the failed Session's title and creator, and binds
     * the linked worktree the failed Session used instead of making a second branch. The failed Session stays as it
     * is.
     */
    private async startFresh(
        retryId: string,
        authority: DelegationAuthority,
        retry: RetryAdmission,
        input: Omit<AgentDelegationCreate, 'sessionId'>,
        worktree: DelegationWorktree | undefined,
    ): Promise<AgentDelegationReceipt> {
        const { newSessions, database } = this.host.options;
        const failed = this.load(retry.retryOf);
        const session = database.getSession(failed.receipt.sessionId);
        if (!newSessions || !session) throw new RetryRefused('not_retryable');
        const sessionId = newSessions.create(
            failed.input.projectId,
            session.title,
            false,
            session.createdBySessionId,
            session.createdBySessionId ? session.createdByRelation : undefined,
            worktree,
        );
        try {
            return await this.host.admit(retryId, authority, { ...input, sessionId }, true, retry);
        } catch (error) {
            if (database.agentDelegations.get(retryId)?.input.sessionId !== sessionId)
                newSessions.discard(sessionId);
            throw error;
        }
    }

    /**
     * `agent.delegation.retryOptions`: which modes could run now. A read; it claims nothing.
     */
    async options(failedId: string): Promise<{ options: DelegationRetryOption[] }> {
        const failed = this.load(failedId);
        return {
            options: [
                await this.optionFor(failed, 'resume'),
                await this.optionFor(failed, 'fresh'),
            ],
        };
    }

    /**
     * `agent.delegation.retry`. The same mode again returns the task it started (also after it finished); the other
     * mode is refused as `already_retried`. Concurrent same-mode requests share one run.
     */
    async retry(
        failedId: string,
        mode: DelegationRetryMode,
    ): Promise<{ delegationId: string; sessionId: string }> {
        const failed = this.load(failedId);
        if (failed.receipt.retriedAs && failed.retryMode !== mode)
            throw this.refused(failed, mode, 'already_retried');
        const receipt = await this.flights.run(`${failedId}\0${mode}`, () =>
            this.run(failedId, mode),
        );
        return { delegationId: receipt.delegationId, sessionId: receipt.sessionId };
    }

    /**
     * A claim without a stored task is a crash between the claim and the insert; nothing was started, so the failed
     * task becomes retryable again. Silent, like the rest of startup recovery.
     */
    recoverClaims(): void {
        for (const record of this.database.agentDelegations.all())
            if (
                record.receipt.retriedAs &&
                !this.database.agentDelegations.get(record.receipt.retriedAs)
            )
                this.releaseClaim(record.receipt.delegationId, false);
    }
}
