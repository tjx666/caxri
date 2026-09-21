import { Check } from 'lucide-react';

import { cn } from '../../lib/utilities';
import {
    sessionToneCalloutClassName,
    sessionUnreadTone,
} from '../primary-sidebar/session-activity';
import { SessionStatusIndicator } from '../primary-sidebar/session-status-indicator';
import { didSelectAgentActivitySession } from './agent-activity-commands';
import type { AgentActivityRow } from './agent-activity-rows';
import { isAgentActivityActionable } from './agent-activity-rows';

/**
 * One Session in the Activity list: the Session title on top, its Project and current state below.
 *
 * Only an actionable row (needs attention, failed) gets a tinted state chip; everything else prints the same phrase in
 * muted text. That two-tier rule is the whole visual grammar of this list — weight means "this one wants you" — so a
 * quiet row must never borrow the chip to look more informative.
 */
export function AgentActivityRowItem({
    onMarkRead,
    relativeTime,
    roving,
    row,
    selected,
    onFocusChange,
}: {
    onFocusChange: (rowId: string) => void;
    onMarkRead: () => void;
    relativeTime: string | undefined;
    roving: boolean;
    row: AgentActivityRow;
    selected: boolean;
}) {
    const { session, status, statusPresentation } = row;
    const actionable = isAgentActivityActionable(row.groupId);
    const canMarkRead = session.hasUnread;
    /**
     * An unread row's chip is tinted by _why_ it needs the user, not by what the Agent happens to be doing now.
     * `statusPresentation` answers the second question, and its answer is `neutral` for the commonest unread state of
     * all — a completed turn — which would print the row in the same muted grey as an Idle one, and `success` for an
     * unread Session still running, which would put a green chip under "Needs attention". `sessionUnreadTone` exists
     * for exactly this: every attention reason collapses to `warning` except an outright failure.
     */
    const chipTone =
        row.groupId === 'attention'
            ? sessionUnreadTone(session.lastAttentionKind ?? 'unknown')
            : statusPresentation.tone;
    return (
        <div
            className={cn(
                'agent-activity-row group/activity-row relative flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-foreground',
                'hover:bg-[color-mix(in_srgb,var(--elevated)_60%,transparent)]',
                'focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none',
                selected && 'active bg-elevated',
            )}
            data-activity-group={row.groupId}
            data-row-id={session.id}
            data-session-id={session.id}
            role="treeitem"
            aria-level={2}
            aria-selected={selected}
            aria-keyshortcuts={canMarkRead ? 'Delete Backspace' : undefined}
            tabIndex={roving ? 0 : -1}
            onFocus={() => onFocusChange(session.id)}
            onClick={() => {
                // Fire-and-forget: the selection reports its own failures through a toast.
                // eslint-disable-next-line no-void -- intentional floating-promise discard
                if (!selected) void didSelectAgentActivitySession(session.id);
            }}
            onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    // Fire-and-forget: the selection reports its own failures through a toast.
                    // eslint-disable-next-line no-void -- intentional floating-promise discard
                    if (!selected) void didSelectAgentActivitySession(session.id);
                    return;
                }
                /*
                 * Delete clears the reminder here rather than archiving the Session, which is what the same key does in
                 * the PrimarySidebar. The two lists answer different questions — that one is "which Sessions exist",
                 * this one is "what is still on my plate" — and removing an item from a queue is what Delete means in a
                 * queue. `aria-keyshortcuts` above announces it, and the row's own button offers the same action.
                 */
                if (canMarkRead && (event.key === 'Delete' || event.key === 'Backspace')) {
                    event.preventDefault();
                    onMarkRead();
                }
            }}
        >
            <SessionStatusIndicator reserveSlot session={session} terminal={row.terminal} />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-xs text-foreground">{session.displayTitle}</span>
                <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted">
                    <span className="agent-activity-project truncate">{row.projectName}</span>
                    <span aria-hidden="true">·</span>
                    <span
                        className={cn(
                            'flex-none rounded px-1',
                            actionable ? sessionToneCalloutClassName(chipTone) : 'text-muted',
                        )}
                    >
                        {status.kind === 'detached' ? 'Detached' : statusPresentation.label}
                    </span>
                    {relativeTime && (
                        <>
                            <span aria-hidden="true">·</span>
                            <span className="flex-none truncate">{relativeTime}</span>
                        </>
                    )}
                </span>
            </span>
            {canMarkRead && (
                /*
                 * `tabIndex={-1}`: inside `role="tree"` the row itself is the only Tab stop (DESIGN.md), so this is the
                 * pointer affordance for an action the keyboard reaches through Delete on the row.
                 */
                <button
                    aria-label={`Mark ${session.displayTitle} as read`}
                    className="agent-activity-mark-read flex-none rounded p-1 text-muted opacity-0 group-hover/activity-row:opacity-100 hover:bg-elevated hover:text-foreground focus-visible:opacity-100"
                    tabIndex={-1}
                    type="button"
                    onClick={(event) => {
                        event.stopPropagation();
                        onMarkRead();
                    }}
                >
                    <Check aria-hidden="true" size={13} />
                </button>
            )}
        </div>
    );
}
