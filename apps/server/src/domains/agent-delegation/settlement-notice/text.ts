import type { AgentDelegationReceipt } from '@caxri/protocol';
import { MAX_DELEGATION_NOTICE_ITEMS } from '@caxri/protocol';

import type { DelegationNoticeKind } from '../../db';

/**
 * Most items one notice message lists; the rest are sent after the caller's next idle.
 */
export const MAX_NOTICE_ITEMS = MAX_DELEGATION_NOTICE_ITEMS;

/**
 * One line of a notice message: a task and what happened to it.
 */
export interface NoticeItem {
    delegationId: string;
    kind: DelegationNoticeKind;
    /**
     * The task's status when it settled; absent for a question or an approval.
     */
    status?: AgentDelegationReceipt['status'];
    /**
     * The Session the task runs in; a hand-back names it as the Session given back.
     */
    sessionId: string;
}

const SETTLED_PHRASES: Partial<Record<AgentDelegationReceipt['status'], string>> = {
    completed: 'completed',
    failed: 'failed',
    interrupted: 'was interrupted',
    human_intervened: 'was taken over by the user',
    answer_unavailable: 'finished, but its answer could not be read',
};

function phrase(item: NoticeItem): string {
    if (item.kind === 'question') return 'is asking you a question';
    if (item.kind === 'approval') return 'needs your approval';
    return SETTLED_PHRASES[item.status!] ?? 'settled';
}

/**
 * The fixed message that wakes a delegating Agent: task IDs, a closed phrase per event, and the commands that read each
 * outcome. It carries no answer, summary, question, request text, or Session title (the child Agent can rename its
 * Session to any text); the Agent reads those through its own authenticated commands. Server text only, so it can never
 * carry a permission, a setting change, or an instruction another Agent wrote (`docs/agent-delegation.md`, Settlement
 * notices).
 */
export function formatSettlementNotice(items: readonly NoticeItem[]): string {
    const handBacks = items.filter((item) => item.kind === 'handback');
    const lines = handBacks.map(
        (item) =>
            `[Caxri] The user handed Session ${item.sessionId} back to you (task ${item.delegationId}). Continue with: caxri agent delegate create --follow-up ${item.delegationId} ...`,
    );
    items = items.filter((item) => item.kind !== 'handback');
    if (items.length === 0) return lines.join('\n');
    lines.push('[Caxri] Delegated task update:');
    for (const item of items) {
        lines.push(`- ${item.delegationId} ${phrase(item)}`);
    }
    for (const item of items)
        if (item.status === 'human_intervened')
            lines.push(
                `The user took over ${item.delegationId}; stop waiting for it unless the user hands it back.`,
            );
    const kinds = new Set(items.map((item) => item.kind));
    const reads = [
        kinds.has('settled') && 'results: caxri agent delegate result <id> --json',
        kinds.has('question') && 'questions: caxri agent delegate questions <id> --json',
        kinds.has('approval') && 'approval requests: caxri agent delegate status <id> --json',
    ].filter(Boolean);
    lines.push(`Read each with (${reads.join('; ')}).`);
    return lines.join('\n');
}
