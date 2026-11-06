import type { AgentDelegationReceipt, DelegationNoticeEvent } from '@caxri/protocol';
import { isDelegationActive } from '@caxri/protocol';

import type { DelegationNoticeKind, StoredDelegationNotice } from '../../db';
import type { NoticeReason, SettlementNoticeSources } from './contract';
import type { NoticeItem } from './text';
import type { NoticeWaiters } from './waiters';

export interface Drop {
    kind: 'skip' | 'discard';
    reason: NoticeReason;
}

/**
 * What to do with a pending notice at send time.
 */
export type Verdict = Drop | { kind: 'send' } | { kind: 'defer'; reason: NoticeReason };

/**
 * What a kind's judge re-reads at send time.
 */
interface JudgeContext {
    notice: StoredDelegationNotice;
    receipt: AgentDelegationReceipt;
    sources: SettlementNoticeSources;
    waiters: NoticeWaiters;
}

/**
 * How a kind reads in a notice message.
 */
type Presentation =
    | {
          /**
           * A line of its own, ahead of the task update list.
           */
          mode: 'standalone';
          line: (item: NoticeItem) => string;
      }
    | {
          /**
           * One entry of the task update list, with the command that reads its outcome.
           */
          mode: 'listed';
          phrase: (item: NoticeItem) => string;
          read: string;
      };

/**
 * Everything the notice pipeline does differently per kind.
 */
interface KindDescriptor {
    presentation: Presentation;
    /**
     * Whether the item carries the task's receipt status (only a settled notice reports one).
     */
    carriesStatus: boolean;
    /**
     * The closed event a Client turns into a status word.
     */
    event: (item: NoticeItem) => DelegationNoticeEvent;
    /**
     * Re-reads the world at send time and decides whether the notice still goes out.
     */
    judge: (context: JudgeContext) => Verdict;
    /**
     * Whether a read before the notice was registered is recorded as an already acknowledged notice, so a plan that
     * held the notice back does not announce it later.
     */
    recordsReadBeforeRegistered: boolean;
}

const SETTLED_PHRASES: Partial<Record<AgentDelegationReceipt['status'], string>> = {
    completed: 'completed',
    failed: 'failed',
    interrupted: 'was interrupted',
    human_intervened: 'was taken over by the user',
    answer_unavailable: 'finished, but its answer could not be read',
};

function judgeOpenRequest(
    { notice, receipt, waiters }: JudgeContext,
    isOpen: () => boolean,
): Verdict {
    if (!(isDelegationActive(receipt) && isOpen())) return { kind: 'skip', reason: 'resolved' };
    return waiters.isWaitingForQuestions(notice.callerTerminalId, notice.delegationId)
        ? { kind: 'defer', reason: 'waiter' }
        : { kind: 'send' };
}

/**
 * The one per-kind owner of the settlement-notice pipeline: text, event, verdict, and acknowledgement. Typed as a
 * `Record` over the stored kind union, so adding a kind to `DelegationNoticeKind` fails typecheck until every per-kind
 * behavior is defined here. Declaration order is the order read commands appear in a message.
 */
export const NOTICE_KINDS: Record<DelegationNoticeKind, KindDescriptor> = {
    settled: {
        presentation: {
            mode: 'listed',
            phrase: (item) => SETTLED_PHRASES[item.status!] ?? 'settled',
            read: 'results: caxri agent delegate result <id> --json',
        },
        carriesStatus: true,
        event: (item) => {
            switch (item.status) {
                case 'completed':
                case 'failed':
                case 'interrupted':
                case 'answer_unavailable': {
                    return item.status;
                }
                case 'human_intervened': {
                    return 'taken_over';
                }
                default: {
                    return 'settled';
                }
            }
        },
        judge: ({ notice, receipt, waiters }) => {
            if (isDelegationActive(receipt)) return { kind: 'skip', reason: 'resolved' };
            if (receipt.retriedAs) return { kind: 'discard', reason: 'retry_pending' };
            return waiters.isWaitingForSettlement(notice.callerTerminalId, notice.delegationId)
                ? { kind: 'defer', reason: 'waiter' }
                : { kind: 'send' };
        },
        recordsReadBeforeRegistered: true,
    },
    question: {
        presentation: {
            mode: 'listed',
            phrase: () => 'is asking you a question',
            read: 'questions: caxri agent delegate questions <id> --json',
        },
        carriesStatus: false,
        event: () => 'question',
        judge: (context) =>
            judgeOpenRequest(context, () =>
                context.sources.isQuestionWithParent(
                    context.notice.delegationId,
                    context.notice.subjectId!,
                ),
            ),
        recordsReadBeforeRegistered: false,
    },
    approval: {
        presentation: {
            mode: 'listed',
            phrase: () => 'needs your approval',
            read: 'approval requests: caxri agent delegate status <id> --json',
        },
        carriesStatus: false,
        event: () => 'approval',
        judge: (context) =>
            judgeOpenRequest(context, () =>
                context.sources.isApprovalDecidable(
                    context.notice.delegationId,
                    context.notice.subjectId!,
                ),
            ),
        recordsReadBeforeRegistered: false,
    },
    handback: {
        presentation: {
            mode: 'standalone',
            line: (item) =>
                `[Caxri] The user handed Session ${item.sessionId} back to you (task ${item.delegationId}). Continue with: caxri agent delegate create --follow-up ${item.delegationId} ...`,
        },
        carriesStatus: false,
        event: () => 'handed_back',
        // A hand-back is owed while the user's grant stands, whatever state the task is in and whoever waits.
        judge: ({ notice, sources }) =>
            sources.isHandBackPending(notice.subjectId!)
                ? { kind: 'send' }
                : { kind: 'skip', reason: 'resolved' },
        recordsReadBeforeRegistered: false,
    },
};
