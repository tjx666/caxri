import type { AgentDelegationReceipt, AgentProvider } from '@caxri/protocol';
import { isDelegationActive } from '@caxri/protocol';

import type { StoredAgentDelegation } from '../db';

/**
 * The failures that mean a usage limit stopped the task, the only ones `failureResetsAt` can describe.
 */
const LIMIT_FAILURES: ReadonlySet<AgentDelegationReceipt['failure']> = new Set([
    'quota_exhausted',
    'rate_limited',
]);

/**
 * Where a usage-limit failure happened, for the reset-time lookup.
 */
export interface DelegationLimitFailure {
    provider: AgentProvider;
    terminalId?: string;
    turnId?: string;
}

function futureTime(time: number | undefined, now: number): number | undefined {
    return time !== undefined && Number.isSafeInteger(time) && time > now ? time : undefined;
}

/**
 * The later of the two authoritative reset times of a usage-limit failure: the provider's own limit notice on the
 * failed turn (`noticed`), and the weekly usage guard that refuses the provider's account until its window resets
 * (`guarded`). Neither is estimated, and a value that is not a safe integer counts as unknown, so a malformed time can
 * never win. It is `undefined` when neither is known.
 *
 * A time already past is not filtered here: {@link stampedReceipt} drops any result that is not after the moment the
 * task failed, so a stale notice neither hides a later guard (the later time wins) nor becomes a reset time on its
 * own.
 */
export function laterResetTime(
    noticed: number | undefined,
    guarded: number | undefined,
): number | undefined {
    const known = [noticed, guarded].filter(
        (time): time is number => time !== undefined && Number.isSafeInteger(time),
    );
    return known.length > 0 ? Math.max(...known) : undefined;
}

/**
 * The receipt a save stores, from the record the caller changed and the receipt stored before it.
 *
 * - `revision` and `updatedAt` always advance.
 * - `settledAt` is set when the task moves from active to settled and kept while it stays settled. `updatedAt` cannot
 *   carry this: a bookkeeping save after the task settled (a claimed answer, a transcript offset) moves it.
 * - `failureResetsAt` is looked up once, when the task moves into a usage-limit failure, and kept until the failure
 *   changes. A lookup that knows no future reset time leaves it absent, because a reset time is never guessed.
 *
 * A receipt that is active carries neither field. This is a defensive invariant, not a transition any path takes today:
 * a follow-up or a resume creates a new task with its own receipt and never re-activates a settled one. It holds by
 * construction (both fields are stripped from the caller's copy before the stamps are recomputed), so a receipt can
 * never read as active and settled at once.
 */
export function stampedReceipt(
    record: Pick<StoredAgentDelegation, 'receipt' | 'turnId'>,
    before: AgentDelegationReceipt | undefined,
    now: number,
    limitResetsAt?: (failure: DelegationLimitFailure) => number | undefined,
): AgentDelegationReceipt {
    const { receipt } = record;
    const { settledAt: carriedSettledAt, failureResetsAt: carriedResetsAt, ...rest } = receipt;
    const stamped: AgentDelegationReceipt = {
        ...rest,
        revision: receipt.revision + 1,
        updatedAt: now,
    };
    if (isDelegationActive(receipt)) return stamped;
    const settledAt =
        before && isDelegationActive(before) ? now : (before?.settledAt ?? carriedSettledAt);
    if (settledAt !== undefined) stamped.settledAt = settledAt;
    if (receipt.status !== 'failed' || !LIMIT_FAILURES.has(receipt.failure)) return stamped;
    const isNewFailure = before?.status !== 'failed' || before.failure !== receipt.failure;
    const resetsAt = isNewFailure
        ? futureTime(
              limitResetsAt?.({
                  provider: receipt.provider,
                  terminalId: receipt.terminalId,
                  turnId: record.turnId,
              }),
              now,
          )
        : (before.failureResetsAt ?? carriedResetsAt);
    if (resetsAt !== undefined) stamped.failureResetsAt = resetsAt;
    return stamped;
}

/**
 * The reset time a failed task's retry can be scheduled for: the one stamped when it failed or, without one, what the
 * lookup finds now. An Antigravity Chat names the window that ran out only after its failed turn ended (issue #4114),
 * so the stamp at the failure can miss a reset time the Chat's notice carries a few seconds later.
 */
export function currentFailureResetsAt(
    record: Pick<StoredAgentDelegation, 'receipt' | 'turnId'>,
    now: number,
    limitResetsAt?: (failure: DelegationLimitFailure) => number | undefined,
): Pick<AgentDelegationReceipt, 'failureResetsAt'> {
    const { receipt } = record;
    if (receipt.failureResetsAt !== undefined) return receipt;
    if (receipt.status !== 'failed' || !LIMIT_FAILURES.has(receipt.failure)) return {};
    const failure = {
        provider: receipt.provider,
        terminalId: receipt.terminalId,
        turnId: record.turnId,
    };
    const resetsAt = futureTime(limitResetsAt?.(failure), now);
    return resetsAt === undefined ? {} : { failureResetsAt: resetsAt };
}
