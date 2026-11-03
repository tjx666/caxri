import type { DelegationRetryScheduleOutcome } from '@caxri/protocol';
import { formatDelegationRetryNotice, formatDelegationRetryRefusedNotice } from '@caxri/protocol';
import { logEventCatalog } from '@caxri/system';

import type { StoredAgentDelegation } from '../db';
import type { AgentDelegationServiceOptions } from './service-options';

/**
 * How a retry notice ended, as a closed enum for the log.
 */
export type RetryNoticeOutcome =
    'sent' | 'duplicate' | 'caller_gone' | 'agent_not_running' | 'rejected' | 'failed';

/**
 * Most notices remembered for deduplication; the oldest is forgotten first.
 */
const MAX_NOTIFIED_RETRIES = 256;

/**
 * What a notice reports: a retry that started, or a scheduled retry that did not run.
 */
type NoticeKind = 'retried' | 'schedule_refused';

type NoticeOptions = Pick<
    AgentDelegationServiceOptions,
    'currentLaunchId' | 'database' | 'logger' | 'write'
>;

/**
 * Delivers one fixed-text notice to the Agent that delegated a failed task, once per `subject`. Both kinds share it so
 * delivery, the launch pin, and the log stay one mechanism. `subject` names what the notice is about (the retry's task
 * ID, or the schedule that was refused) and is the deduplication key.
 */
function createCallerNotice(
    options: NoticeOptions,
    isCallerLive: (failed: StoredAgentDelegation) => boolean,
    kind: NoticeKind,
): (failed: StoredAgentDelegation, subject: string, text: string) => RetryNoticeOutcome {
    const notified = new Set<string>();
    const log = (outcome: RetryNoticeOutcome, failedId: string, subject: string) =>
        options.logger?.write(
            outcome === 'sent' || outcome === 'duplicate' ? 'info' : 'warn',
            logEventCatalog.agentDelegation.retryNotice,
            {
                fields: {
                    outcome,
                    kind,
                    delegationId: failedId,
                    ...(kind === 'retried' && { retryId: subject }),
                },
            },
        );
    const deliver = (
        failed: StoredAgentDelegation,
        subject: string,
        text: string,
    ): RetryNoticeOutcome => {
        const terminalId = failed.receipt.callerTerminalId;
        if (!terminalId || !options.database.getTerminal(terminalId)) return 'caller_gone';
        // The caller must still be the live Endpoint generation that delegated the task, as at admission.
        if (!isCallerLive(failed)) return 'caller_gone';
        const launchId = options.currentLaunchId?.(terminalId);
        if (!launchId) return 'agent_not_running';
        const isAccepted = options.write?.(
            terminalId,
            launchId,
            `\u{1B}[200~${text}\u{1B}[201~\r`,
            // The Host can still refuse a write it admitted; record that as its own transition.
            (wasDelivered) => {
                if (!wasDelivered) log('rejected', failed.receipt.delegationId, subject);
            },
        );
        return isAccepted ? 'sent' : 'rejected';
    };
    return (failed, subject, text) => {
        // Recorded before delivery so two paths to the same notice cannot both send.
        if (notified.has(subject)) {
            log('duplicate', failed.receipt.delegationId, subject);
            return 'duplicate';
        }
        notified.add(subject);
        if (notified.size > MAX_NOTIFIED_RETRIES) notified.delete(notified.values().next().value!);
        let outcome: RetryNoticeOutcome;
        try {
            outcome = deliver(failed, subject, text);
        } catch {
            outcome = 'failed';
        }
        log(outcome, failed.receipt.delegationId, subject);
        return outcome;
    };
}

/**
 * Tells the Agent that delegated a failed task that the owner retried it, once per retry. A `wait` that already
 * returned `failed` is finished and never learns of the retry, and an Agent that stopped waiting will not poll
 * `status`. A scheduled retry that starts reuses this notice: it is the same event for the Agent.
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
    options: NoticeOptions,
    isCallerLive: (failed: StoredAgentDelegation) => boolean,
): (failed: StoredAgentDelegation, retryId: string) => RetryNoticeOutcome {
    const send = createCallerNotice(options, isCallerLive, 'retried');
    return (failed, retryId) =>
        send(failed, retryId, formatDelegationRetryNotice(failed.receipt.delegationId, retryId));
}

/**
 * Tells the Agent that delegated a failed task that its scheduled retry did not run, so it stops waiting for one. The
 * text is fixed and carries the task ID and the closed outcome only. Best effort: the caller is often gone by then, and
 * a lost notice never changes the refusal, which the failed task's receipt records. Pass the record as it was while the
 * schedule was pending, so a second refusal of a later schedule is not mistaken for a duplicate.
 */
export function createRetryRefusedNotice(
    options: NoticeOptions,
    isCallerLive: (failed: StoredAgentDelegation) => boolean,
): (failed: StoredAgentDelegation, outcome: DelegationRetryScheduleOutcome) => RetryNoticeOutcome {
    const send = createCallerNotice(options, isCallerLive, 'schedule_refused');
    return (failed, outcome) =>
        send(
            failed,
            `${failed.receipt.delegationId}\0${failed.receipt.retryScheduledFor ?? 0}`,
            formatDelegationRetryRefusedNotice(failed.receipt.delegationId, outcome),
        );
}
