import type { AgentDelegationReceipt } from '@caxri/protocol';
import { MAX_DELEGATION_NOTICE_ITEMS } from '@caxri/protocol';

import type { DelegationNoticeKind } from '../../db';
import { NOTICE_KINDS } from './kinds';

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
    /**
     * Who handed the Session back, for a hand-back: Caxri after the user left it alone (`auto`) is worded so the
     * delegating Agent never tells the user they handed back what Caxri did.
     */
    handBackTrigger?: 'auto' | 'user';
}

/**
 * The fixed message that wakes a delegating Agent: task IDs, a closed phrase per event, and the commands that read each
 * outcome. It carries no answer, summary, question, request text, or Session title (the child Agent can rename its
 * Session to any text); the Agent reads those through its own authenticated commands. Server text only, so it can never
 * carry a permission, a setting change, or an instruction another Agent wrote (`docs/agent-delegation.md`, Settlement
 * notices).
 */
export function formatSettlementNotice(items: readonly NoticeItem[]): string {
    const lines: string[] = [];
    const listed: NoticeItem[] = [];
    for (const item of items) {
        const { presentation } = NOTICE_KINDS[item.kind];
        if (presentation.mode === 'standalone') lines.push(presentation.line(item));
        else listed.push(item);
    }
    if (listed.length === 0) return lines.join('\n');
    lines.push('[Caxri] Delegated task update:');
    for (const item of listed) {
        const { presentation } = NOTICE_KINDS[item.kind];
        if (presentation.mode === 'listed')
            lines.push(`- ${item.delegationId} ${presentation.phrase(item)}`);
    }
    for (const item of listed)
        if (item.status === 'human_intervened')
            lines.push(
                `The user took over ${item.delegationId}; stop waiting for it unless the user hands it back.`,
            );
    const kinds = new Set(listed.map((item) => item.kind));
    const reads: string[] = [];
    for (const [kind, descriptor] of Object.entries(NOTICE_KINDS))
        if (kinds.has(kind as DelegationNoticeKind) && descriptor.presentation.mode === 'listed')
            reads.push(descriptor.presentation.read);
    lines.push(`Read each with (${reads.join('; ')}).`);
    return lines.join('\n');
}
