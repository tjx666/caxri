import type { AgentHeldMessage } from '@caxri/protocol';
import { Inbox } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { heldMessageDeadlineLabel } from './agent-message-approval-state';

interface AgentMessageApprovalWaitingListProperties {
    approvals: readonly AgentHeldMessage[];
    onReview: (messageId: string) => void;
}

/**
 * Where a set-aside peer message waits. Escape on the approval modal only retires the presentation: the request is
 * still held and its sender is still waiting, so the deferred state has to keep standing somewhere the user can find
 * it, without a backdrop, a focus trap, or a modal that re-opens itself.
 *
 * It sits bottom-left because notifications already own the bottom-right corner above the status bar.
 */
export function AgentMessageApprovalWaitingList({
    approvals,
    onReview,
}: AgentMessageApprovalWaitingListProperties) {
    if (approvals.length === 0) return null;

    return (
        <section
            aria-label="Peer messages waiting for your decision"
            data-testid="agent-message-approval-waiting-list"
            className="fixed bottom-8 left-4 z-40 w-80 overflow-hidden rounded-lg border border-border bg-elevated shadow-[0_16px_48px_var(--shadow)]"
        >
            <header className="border-b border-border px-3 py-2">
                <div className="flex items-center gap-2">
                    <Inbox aria-hidden="true" size={14} className="shrink-0 text-muted" />
                    <h2 className="m-0 text-[12px] font-semibold">Waiting for your decision</h2>
                    <span className="ml-auto rounded bg-badge px-1.5 text-[11px] text-badge-foreground">
                        {approvals.length}
                    </span>
                </div>
                <p className="m-0 mt-1 text-[11px] leading-[1.45] text-muted">
                    Nothing was answered. Each sender is still waiting until its approval window
                    closes.
                </p>
            </header>
            <ul className="m-0 max-h-52 list-none overflow-auto p-0">
                {approvals.map((approval) => (
                    <li
                        key={approval.messageId}
                        className="flex items-center gap-2 border-b border-border px-3 py-2 last:border-0"
                    >
                        <div className="min-w-0 flex-1">
                            <div className="flex items-baseline gap-2">
                                <span className="truncate text-[12px]">{approval.from.name}</span>
                                <time
                                    className="ml-auto shrink-0 text-[11px] text-muted"
                                    dateTime={new Date(approval.expiresAt).toISOString()}
                                >
                                    {`Until ${heldMessageDeadlineLabel(approval.expiresAt)}`}
                                </time>
                            </div>
                            <p className="m-0 truncate text-[11px] text-muted">
                                {approval.preview}
                            </p>
                        </div>
                        <Button
                            variant="secondary"
                            size="sm"
                            aria-label={`Review the message from ${approval.from.name}`}
                            onClick={() => onReview(approval.messageId)}
                        >
                            Review
                        </Button>
                    </li>
                ))}
            </ul>
        </section>
    );
}
