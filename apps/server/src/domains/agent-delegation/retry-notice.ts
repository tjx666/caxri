import { formatDelegationRetryNotice } from '@caxri/protocol';
import { logEventCatalog } from '@caxri/system';

import type { StoredAgentDelegation } from '../db';
import type { AgentDelegationServiceOptions } from './service-options';

/**
 * How a retry notice ended, as a closed enum for the log.
 */
export type RetryNoticeOutcome =
    'sent' | 'duplicate' | 'caller_gone' | 'agent_not_running' | 'rejected' | 'failed';

/**
 * Most retries remembered for deduplication; the oldest is forgotten first.
 */
const MAX_NOTIFIED_RETRIES = 256;

/**
 * Tells the Agent that delegated a failed task that the owner retried it, once per retry. A `wait` that already
 * returned `failed` is finished and never learns of the retry, and an Agent that stopped waiting will not poll
 * `status`.
 *
 * The notice is written with the same launch-pinned `write` a follow-up pointer uses, never as a Chat message: that
 * keeps it from counting as the user taking the Chat over, and it is refused if the caller's launch changed since. It
 * carries the two task IDs and a fixed instruction, nothing from the task. Delivery is best effort and never fails the
 * retry, which already started.
 *
 * Like the pull request merge notice (`pull-request/merge-notice.ts`), it is not fenced on the caller's input epoch:
 * the owner just clicked Retry in Caxri, so a half-typed line in a PTY caller is unlikely, and an epoch fence would
 * need a baseline captured when the task failed.
 */
export function createRetryNotice(
    options: Pick<
        AgentDelegationServiceOptions,
        'currentLaunchId' | 'database' | 'logger' | 'write'
    >,
    isCallerLive: (failed: StoredAgentDelegation) => boolean,
): (failed: StoredAgentDelegation, retryId: string) => RetryNoticeOutcome {
    const notified = new Set<string>();
    const log = (outcome: RetryNoticeOutcome, failedId: string, retryId: string) =>
        options.logger?.write(
            outcome === 'sent' || outcome === 'duplicate' ? 'info' : 'warn',
            logEventCatalog.agentDelegation.retryNotice,
            { fields: { outcome, delegationId: failedId, retryId } },
        );
    const deliver = (failed: StoredAgentDelegation, retryId: string): RetryNoticeOutcome => {
        const terminalId = failed.receipt.callerTerminalId;
        if (!terminalId || !options.database.getTerminal(terminalId)) return 'caller_gone';
        // The caller must still be the live Endpoint generation that delegated the task, as at admission.
        if (!isCallerLive(failed)) return 'caller_gone';
        const launchId = options.currentLaunchId?.(terminalId);
        if (!launchId) return 'agent_not_running';
        const text = formatDelegationRetryNotice(failed.receipt.delegationId, retryId);
        const isAccepted = options.write?.(
            terminalId,
            launchId,
            `\u{1B}[200~${text}\u{1B}[201~\r`,
            // The Host can still refuse a write it admitted; record that as its own transition.
            (wasDelivered) => {
                if (!wasDelivered) log('rejected', failed.receipt.delegationId, retryId);
            },
        );
        return isAccepted ? 'sent' : 'rejected';
    };
    return (failed, retryId) => {
        // Recorded before delivery so two paths to the same retry cannot both send.
        if (notified.has(retryId)) {
            log('duplicate', failed.receipt.delegationId, retryId);
            return 'duplicate';
        }
        notified.add(retryId);
        if (notified.size > MAX_NOTIFIED_RETRIES) notified.delete(notified.values().next().value!);
        let outcome: RetryNoticeOutcome;
        try {
            outcome = deliver(failed, retryId);
        } catch {
            outcome = 'failed';
        }
        log(outcome, failed.receipt.delegationId, retryId);
        return outcome;
    };
}
