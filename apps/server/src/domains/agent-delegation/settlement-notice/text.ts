import type { AgentDelegationReceipt } from '@caxri/protocol';

import type { DelegationNoticeKind } from '../../db';

/**
 * Most characters of a Session title a notice carries.
 */
const MAX_TITLE_LENGTH = 80;

/**
 * Most items one notice message lists; the rest are sent after the caller's next idle.
 */
export const MAX_NOTICE_ITEMS = 32;

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
     * The child Session's title, the caller's own data.
     */
    title?: string;
}

/**
 * A title as one line the caller can quote: control characters and newlines become spaces, quotes become apostrophes so
 * the title cannot close its own quotation, runs of whitespace collapse, and the length is capped.
 */
export function sanitizeNoticeTitle(title: string | undefined): string {
    const line = (title ?? '')
        .replaceAll(/\p{Cc}/gu, ' ')
        .replaceAll('"', "'")
        .replaceAll(/\s+/gu, ' ')
        .trim();
    return line.length > MAX_TITLE_LENGTH ? `${line.slice(0, MAX_TITLE_LENGTH - 1)}…` : line;
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
 * The fixed message that wakes a delegating Agent: task IDs, the child Session's title, a closed phrase per event, and
 * the commands that read each outcome. It carries no answer, summary, question, or request text; the Agent reads those
 * through its own authenticated commands. Server text only, so it can never carry a permission, a setting change, or an
 * instruction another Agent wrote (`docs/agent-delegation.md`, Settlement notices).
 */
export function formatSettlementNotice(items: readonly NoticeItem[]): string {
    const lines = ['[Caxri] Delegated task update:'];
    for (const item of items) {
        const title = sanitizeNoticeTitle(item.title);
        lines.push(`- ${item.delegationId}${title ? ` "${title}"` : ''} ${phrase(item)}`);
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
