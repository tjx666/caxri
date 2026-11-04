import { createHash } from 'node:crypto';

import type {
    AgentDelegationReceipt,
    DelegationRedirectRefusal,
    DelegationRedirectState,
} from '@caxri/protocol';
import {
    CaxriError,
    delegatedRedirectMessage,
    isDelegationActive,
    MAX_DELEGATION_REDIRECT_OPERATIONS,
} from '@caxri/protocol';

import type { StoredAgentDelegation } from '../db';
import type { DelegationAuthority } from './admission';
import { logDelegationRedirect } from './diagnostics';
import type { AgentDelegationServiceOptions } from './service-options';

/**
 * What redirecting a task borrows from the delegation service.
 */
export interface DelegationRedirectHost {
    options: Pick<
        AgentDelegationServiceOptions,
        'currentLaunchId' | 'database' | 'inputEpoch' | 'isChatTerminal' | 'logger' | 'steer'
    >;
    now: () => number;
    owned(id: string, authority: DelegationAuthority, access: 'existing'): StoredAgentDelegation;
    save(record: StoredAgentDelegation): StoredAgentDelegation;
    questions: { openId(delegationId: string): string | undefined };
    approvals: { viewFor(delegationId: string): unknown };
}

/**
 * What a caller reads for each refusal. Closed wording: the caller's text never appears in an error.
 */
const REFUSALS: Record<DelegationRedirectRefusal, string> = {
    not_running: 'The task is not running, so there is no turn to redirect',
    waiting: 'The task is waiting on a question or a permission request; answer that first',
    not_chat: 'Only a task that runs in a Chat can be redirected',
    human_intervened: 'A person took this task over, so it can no longer be redirected',
    launch_replaced: "The task's Agent is no longer the process it started on",
    turn_changed: 'The turn this task runs in is over; use a follow-up for new work',
    not_steerable: 'The running turn takes no steered input right now',
    operation_reused: 'This operation ID was already used for different text',
    too_many_operations: 'This task already recorded the most redirects it keeps',
    delivery_unknown:
        'The direction may or may not have reached the Agent; read the transcript before sending anything else',
};

function refusal(reason: DelegationRedirectRefusal): CaxriError {
    return new CaxriError('CONFLICT', REFUSALS[reason], { reason });
}

/**
 * The closed reason a steer was refused, or `undefined` when nothing says it was (the delivery is then in doubt).
 */
function steerRefusalReason(error: unknown): DelegationRedirectRefusal | undefined {
    const details = error instanceof CaxriError ? error.details : undefined;
    const reason = details?.steerRefusal;
    return typeof reason === 'string' && reason in REFUSALS
        ? (reason as DelegationRedirectRefusal)
        : undefined;
}

type Claim = NonNullable<StoredAgentDelegation['redirects']>[number];

function withClaim(
    record: StoredAgentDelegation,
    claim: Claim,
    receipt = record.receipt,
): StoredAgentDelegation {
    const others = (record.redirects ?? []).filter(
        (entry) => entry.operationId !== claim.operationId,
    );
    return { ...record, receipt, redirects: [...others, claim] };
}

/**
 * Strict redirect of a running Chat task (`agent.delegation.redirect`): one message steered into the task's own turn,
 * or a closed refusal. It reuses the task's identity and turn, so result, cost, and the answer's return to the
 * delegating Agent are unchanged, and it is not human input, so the task is not taken over.
 *
 * A request is safe to repeat. Each redirect has an operation ID, and a claim for it is written to the task before the
 * message is sent: a repeat with the same text is answered from the claim, and a claim still `pending` or `unknown`
 * (the provider did not confirm, or the Server restarted mid-delivery) is never sent again, because the message may
 * already be in the conversation. The in-memory command receipts cannot promise that alone: they are evicted.
 */
export class DelegationRedirects {
    /**
     * The attempts running now, so a duplicate request waits for the first instead of reporting doubt.
     */
    private readonly attempts = new Map<string, Promise<AgentDelegationReceipt>>();

    constructor(private readonly host: DelegationRedirectHost) {}

    private async run(
        record: StoredAgentDelegation,
        input: { delegationId: string; operationId: string; text: string },
    ): Promise<{ receipt: AgentDelegationReceipt; isReplay: boolean }> {
        const digest = createHash('sha256').update(input.text).digest('hex');
        const key = `${input.delegationId}\0${input.operationId}`;
        const claim = record.redirects?.find((entry) => entry.operationId === input.operationId);
        if (claim) {
            if (claim.digest !== digest) throw refusal('operation_reused');
            if (claim.state === 'delivered') return { receipt: record.receipt, isReplay: true };
            const attempt = claim.state === 'pending' ? this.attempts.get(key) : undefined;
            if (!attempt) throw refusal('delivery_unknown');
            return { receipt: await attempt, isReplay: true };
        }
        const target = this.admit(record);
        const attempt = this.deliver(record, target, input, digest);
        this.attempts.set(key, attempt);
        try {
            return { receipt: await attempt, isReplay: false };
        } finally {
            this.attempts.delete(key);
        }
    }

    /**
     * Checks, synchronously and in a fixed order, that the task is a running Chat child nobody took over, whose Agent
     * is the launch it started on and is not waiting on anything. The same facts are checked again at the head of the
     * Chat's send chain, where the turn and the input epoch are exact.
     */
    private admit(record: StoredAgentDelegation): {
        terminalId: string;
        launchId: string;
        turnId: string;
    } {
        const { options, questions, approvals } = this.host;
        const { receipt } = record;
        if (receipt.status === 'blocked') throw refusal('waiting');
        if (receipt.status === 'human_intervened') throw refusal('human_intervened');
        if (!isDelegationActive(receipt) || receipt.status !== 'running')
            throw refusal('not_running');
        const { terminalId } = receipt;
        if (!terminalId || !options.isChatTerminal?.(terminalId) || !options.steer)
            throw refusal('not_chat');
        if (record.hasHumanIntervention) throw refusal('human_intervened');
        if (questions.openId(receipt.delegationId) || approvals.viewFor(receipt.delegationId))
            throw refusal('waiting');
        if (!record.launchId || options.currentLaunchId?.(terminalId) !== record.launchId)
            throw refusal('launch_replaced');
        if (options.inputEpoch?.(terminalId) !== record.inputEpoch)
            throw refusal('human_intervened');
        if (!record.turnId) throw refusal('turn_changed');
        if ((record.redirects?.length ?? 0) >= MAX_DELEGATION_REDIRECT_OPERATIONS)
            throw refusal('too_many_operations');
        return { terminalId, launchId: record.launchId, turnId: record.turnId };
    }

    private async deliver(
        record: StoredAgentDelegation,
        target: { terminalId: string; launchId: string; turnId: string },
        input: { delegationId: string; operationId: string; text: string },
        digest: string,
    ): Promise<AgentDelegationReceipt> {
        const { database } = this.host.options;
        const id = input.delegationId;
        const claim = (state: DelegationRedirectState): Claim => ({
            operationId: input.operationId,
            digest,
            state,
            at: this.host.now(),
        });
        this.host.save(withClaim(record, claim('pending')));
        try {
            await this.host.options.steer!(target.terminalId, target.launchId, {
                turnId: target.turnId,
                inputEpoch: record.inputEpoch,
                text: delegatedRedirectMessage(id, input.operationId, input.text),
            });
        } catch (error) {
            // Re-read: the task may have changed (a takeover, a settlement) while the message was in flight.
            const latest = database.agentDelegations.get(id);
            const reason = steerRefusalReason(error);
            if (latest) {
                this.host.save(
                    reason
                        ? {
                              ...latest,
                              redirects: latest.redirects?.filter(
                                  (entry) => entry.operationId !== input.operationId,
                              ),
                          }
                        : withClaim(latest, claim('unknown')),
                );
            }
            throw refusal(reason ?? 'delivery_unknown');
        }
        const latest = database.agentDelegations.get(id);
        if (!latest) throw new CaxriError('NOT_FOUND', 'Delegation is unavailable');
        const redirectCount = (latest.receipt.redirectCount ?? 0) + 1;
        return this.host.save(
            withClaim(latest, claim('delivered'), {
                ...latest.receipt,
                redirectCount,
                redirectedAt: this.host.now(),
            }),
        ).receipt;
    }

    async redirect(
        authority: DelegationAuthority,
        input: { delegationId: string; operationId: string; text: string },
    ): Promise<AgentDelegationReceipt> {
        const startedAt = performance.now();
        let outcome: 'delivered' | 'replayed' | 'refused' | 'unknown' = 'refused';
        let reason = null as DelegationRedirectRefusal | null;
        let receipt: AgentDelegationReceipt | undefined;
        try {
            const record = this.host.owned(input.delegationId, authority, 'existing');
            const result = await this.run(record, input);
            receipt = result.receipt;
            outcome = result.isReplay ? 'replayed' : 'delivered';
            return receipt;
        } catch (error) {
            reason =
                error instanceof CaxriError
                    ? ((error.details?.reason as DelegationRedirectRefusal | undefined) ?? null)
                    : null;
            if (reason === 'delivery_unknown') outcome = 'unknown';
            throw error;
        } finally {
            logDelegationRedirect(this.host.options.logger, {
                delegationId: input.delegationId,
                outcome,
                reason,
                principalKind: authority.principal.kind,
                textLength: input.text.length,
                redirectCount:
                    receipt?.redirectCount ??
                    this.host.options.database.agentDelegations.get(input.delegationId)?.receipt
                        .redirectCount ??
                    0,
                durationMs: Math.round(performance.now() - startedAt),
            });
        }
    }

    /**
     * Marks every claim a Server restart left in flight as in doubt. Runs before restart recovery rewrites the tasks,
     * so that recovery reads the claims already settled.
     */
    recover(): void {
        for (const record of this.host.options.database.agentDelegations.active())
            if (record.redirects?.some((claim) => claim.state === 'pending'))
                this.host.save({
                    ...record,
                    redirects: record.redirects.map((claim) =>
                        claim.state === 'pending' ? { ...claim, state: 'unknown' } : claim,
                    ),
                });
    }
}
