import type { ComponentType } from 'react';

import {
    Check,
    Circle,
    CircleCheck,
    CircleDashed,
    CircleQuestionMark,
    CircleX,
    Unplug,
} from 'lucide-react';

import { Spinner } from '../../components/ui/spinner';
import { Tooltip } from '../../components/ui/tooltip';
import { cn } from '../../lib/utilities';
import { didSelectSession } from '../session/session-commands';
import type { AgentActivityGlyphId } from './agent-activity-glyph';
import { agentActivityGlyph } from './agent-activity-glyph';
import type { AgentActivityRow } from './agent-activity-rows';

/**
 * The shape each state is drawn as. Split from {@link agentActivityGlyph}'s pure mapping so the decision that picks a
 * state can be unit-tested without React; this half only turns the chosen id into a component.
 */
const GLYPH_COMPONENTS: Record<AgentActivityGlyphId, ComponentType<{ size?: number }>> = {
    check: CircleCheck,
    dashed: CircleDashed,
    hollow: Circle,
    question: CircleQuestionMark,
    spinner: Spinner,
    unplug: Unplug,
    x: CircleX,
};

/**
 * One Session in the Activity list: a state glyph, the Session title, and the Project and time below it.
 *
 * The state is a shape rather than a phrase because every group heading already names it — a row under "Working" that
 * also prints "Working" repeats its own heading, and the phrase costs the width the Project name needs in a 230px
 * column. `agent-activity-glyph.ts` owns which shape, which words, and the two-tier tone rule behind them.
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
    const { session } = row;
    const canMarkRead = session.hasUnread;
    const glyph = agentActivityGlyph(row);
    const GlyphIcon = GLYPH_COMPONENTS[glyph.id];
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
                if (!selected) void didSelectSession(session.id);
            }}
            onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    // Fire-and-forget: the selection reports its own failures through a toast.
                    // eslint-disable-next-line no-void -- intentional floating-promise discard
                    if (!selected) void didSelectSession(session.id);
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
            <Tooltip content={glyph.label}>
                <span
                    role="img"
                    aria-label={glyph.label}
                    className={cn(
                        'agent-activity-glyph flex size-3.5 flex-none items-center justify-center',
                        glyph.toneClassName,
                    )}
                    data-activity-glyph={glyph.id}
                    tabIndex={-1}
                >
                    <GlyphIcon size={14} />
                </span>
            </Tooltip>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                {/*
                 * The title owns its line outright. Its neighbours moved down because it is the only value here that is
                 * routinely long — "Rate limiter for /v1/search" against a Project name that is usually one short word
                 * — so at the Primary Side Bar's 230px default it was the one truncating while a Project name and a
                 * time sat beside it with room to spare.
                 */}
                <span className={cn('truncate text-xs text-foreground', canMarkRead && 'pr-6')}>
                    {session.displayTitle}
                </span>
                <span className="agent-activity-metadata flex h-4 min-w-0 flex-wrap items-start gap-x-1.5 overflow-hidden text-[11px] leading-4 text-muted">
                    {/*
                     * The Project name is the one value that must survive: the list is flat, so it is the only thing
                     * telling the user which repository a row belongs to. The unbreakable time wraps below the clipped
                     * single line before the Project loses width; a Project wider than the whole line still truncates.
                     */}
                    <Tooltip content={row.projectName}>
                        <span
                            className="agent-activity-project max-w-full min-w-0 shrink-0 truncate"
                            tabIndex={-1}
                        >
                            {row.projectName}
                        </span>
                    </Tooltip>
                    {relativeTime && (
                        <span className="agent-activity-time flex flex-none gap-1.5 whitespace-nowrap">
                            <span aria-hidden="true">·</span>
                            <span>{relativeTime}</span>
                        </span>
                    )}
                </span>
            </span>
            {canMarkRead && (
                /*
                 * `tabIndex={-1}`: inside `role="tree"` the row itself is the only Tab stop (DESIGN.md), so this is the
                 * pointer affordance for an action the keyboard reaches through Delete on the row.
                 *
                 * Positioned rather than laid out, at the end of the title line the time vacated. An unread row
                 * reserves its width up front (`pr-6` on the title above, three pixels clear of this button's 21px)
                 * instead of surrendering it on hover, so the title never reflows under the pointer — and a read row,
                 * which can never show this button, keeps the full line.
                 */
                <button
                    aria-label={`Mark ${session.displayTitle} as read`}
                    className="agent-activity-mark-read absolute top-1.5 right-2 rounded p-1 text-muted opacity-0 group-hover/activity-row:opacity-100 hover:bg-elevated hover:text-foreground focus-visible:opacity-100"
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
