import type { ComponentType } from 'react';
import { useState } from 'react';

import type { ProjectRecord, TerminalRecord } from '@caxri/protocol';
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
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { WorktreeIcon } from '../../icons/codicons/worktree-icon';
import { cn } from '../../lib/utilities';
import { useSessionPullRequest } from '../primary-sidebar/hooks/use-session-pull-request';
import { SessionActivityCard } from '../primary-sidebar/session-activity-card';
import { SessionPullRequestIndicator } from '../primary-sidebar/session-pull-request-indicator';
import { sessionRowActionButton } from '../primary-sidebar/session-row-actions';
import { SessionRowMenu } from '../primary-sidebar/session-row-menu';
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
 * One Session in the Activity list: a state glyph, the Session title with its pull request, and below them the Agent,
 * Project, worktree, and time.
 *
 * The state is a shape rather than a phrase because every group heading already names it — a row under "Working" that
 * also prints "Working" repeats its own heading, and the phrase costs the width the Project name needs in a 230px
 * column. `agent-activity-glyph.ts` owns which shape, which words, and the tone rule behind them.
 *
 * The row wears the same hover card and context menu as a Project tree row, so a Session reads and acts the same in
 * either body of the side bar; only Rename is missing, because this list has no inline editor to open.
 */
export function AgentActivityRowItem({
    onMarkRead,
    relativeTime,
    roving,
    row,
    selected,
    terminals,
    worktreeProject,
    onFocusChange,
}: {
    onFocusChange: (rowId: string) => void;
    onMarkRead: () => void;
    relativeTime: string | undefined;
    roving: boolean;
    row: AgentActivityRow;
    selected: boolean;
    terminals: TerminalRecord[];
    /**
     * Workbench Root Project when this Session works in a linked worktree instead of its own Project root.
     */
    worktreeProject: ProjectRecord | undefined;
}) {
    const { project, session, terminal } = row;
    const canMarkRead = session.hasUnread;
    const glyph = agentActivityGlyph(row);
    const GlyphIcon = GLYPH_COMPONENTS[glyph.id];
    const { pullRequest, unavailable: pullRequestUnavailable } = useSessionPullRequest(session.id);
    const visiblePullRequest = pullRequestUnavailable ? undefined : pullRequest;
    /**
     * The hover card opens on a delay and would otherwise pop over an open context menu; closing it while the menu is
     * open keeps one popup on screen at a time, the same as a Project tree row.
     */
    const [menuOpen, setMenuOpen] = useState(false);
    const trigger = (
        <div
            className={cn(
                'agent-activity-row relative flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-foreground',
                'hover:bg-[color-mix(in_srgb,var(--elevated)_60%,transparent)]',
                'focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none',
                selected && 'active bg-elevated',
                /*
                 * The Project tree's hover-action rule: while the mark-read chip shows, the text makes room for it and
                 * fades before it instead of painting under it. A pull request slot is already wider than the chip.
                 */
                canMarkRead && visiblePullRequest === undefined && 'group-hover/activity-row:pr-7',
            )}
            data-activity-group={row.groupId}
            data-row-id={session.id}
            data-session-id={session.id}
            role="treeitem"
            aria-level={2}
            aria-description={
                !canMarkRead && row.groupId === 'attention' ? 'Viewed and read' : undefined
            }
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
            {/*
             * No tooltip of its own: the row's hover card already spells the state out, and a second hover popup on
             * the same row would compete with it. The accessible name keeps the words for assistive technology.
             */}
            <span
                role="img"
                aria-label={glyph.label}
                className={cn(
                    'agent-activity-glyph flex size-3.5 flex-none items-center justify-center',
                    glyph.toneClassName,
                )}
                data-activity-glyph={glyph.id}
            >
                <GlyphIcon size={14} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                {/*
                 * The title owns its line outright. Its neighbours moved down because it is the only value here that is
                 * routinely long — "Rate limiter for /v1/search" against a Project name that is usually one short word
                 * — so at the Primary Side Bar's 230px default it was the one truncating while a Project name and a
                 * time sat beside it with room to spare.
                 */}
                <span className="min-w-0 truncate text-xs text-foreground">
                    {session.displayTitle}
                </span>
                <span className="agent-activity-metadata flex h-4 min-w-0 flex-wrap items-start gap-x-1.5 overflow-hidden text-[11px] leading-4 text-muted">
                    {/*
                     * Where the Session runs, in the order a user narrows it down: which Agent CLI, which repository,
                     * which worktree. The Project name is the one value that must survive: the list is flat, so it is
                     * the only thing telling the user which repository a row belongs to. This group is one flex item, so
                     * the unbreakable time wraps below the clipped single line before any of it loses width; inside it
                     * the worktree name truncates first, and a Project wider than the whole line truncates last.
                     */}
                    <span className="agent-activity-location flex h-4 max-w-full min-w-0 items-center gap-1">
                        <span className="flex size-3 flex-none items-center justify-center">
                            <AgentIdentityIcon identity={terminal?.kind ?? 'shell'} size={12} />
                        </span>
                        <span className="agent-activity-project max-w-[calc(100%-1rem)] min-w-0 shrink-0 truncate">
                            {project.displayTitle}
                        </span>
                        {worktreeProject && (
                            <span
                                className="agent-activity-worktree flex min-w-0 shrink items-center gap-0.5"
                                data-session-worktree={worktreeProject.displayTitle}
                            >
                                <WorktreeIcon className="flex-none" size={11} />
                                <span className="truncate">{worktreeProject.displayTitle}</span>
                            </span>
                        )}
                    </span>
                    {relativeTime && (
                        <span className="agent-activity-time flex flex-none gap-1.5 whitespace-nowrap">
                            <span aria-hidden="true">·</span>
                            <span>{relativeTime}</span>
                        </span>
                    )}
                </span>
            </span>
            {/*
             * The pull request glyph sits in a right-edge slot centered on the whole two-line row, not on the title
             * line: pinned to the title it floated in the top-right corner, detached from the metadata it describes.
             * Only a pull request reserves the slot. The mark-read button overlays the right edge instead, because a
             * slot reserved for a hover-only action would cost every unread row the width its Project name needs at
             * the side bar's minimum width.
             */}
            {visiblePullRequest !== undefined && (
                <span className="agent-activity-trailing flex w-5 flex-none justify-end">
                    <SessionPullRequestIndicator
                        className={cn(
                            canMarkRead && 'transition-opacity group-hover/activity-row:opacity-0',
                        )}
                        pullRequest={visiblePullRequest}
                    />
                </span>
            )}
        </div>
    );
    return (
        <SessionRowMenu
            onMarkRead={canMarkRead ? onMarkRead : undefined}
            onOpenChange={setMenuOpen}
            project={project}
            pullRequest={visiblePullRequest}
            session={session}
            terminals={terminals}
        >
            <div className="agent-activity-row-shell group/activity-row relative">
                <SessionActivityCard
                    project={project}
                    pullRequest={pullRequest}
                    pullRequestUnavailable={pullRequestUnavailable}
                    session={session}
                    suppressed={menuOpen}
                    terminal={terminal}
                    trigger={trigger}
                    worktreeProject={worktreeProject}
                />
                {canMarkRead && (
                    /*
                     * A sibling of the row rather than a child, the same way a Project tree row keeps its hover
                     * actions outside the hover card's trigger: a pointer on the button is not a pointer asking for the
                     * card.
                     *
                     * `tabIndex={-1}`: inside `role="tree"` the row itself is the only Tab stop (DESIGN.md), so this is
                     * the pointer affordance for an action the keyboard reaches through Delete on the row.
                     */
                    <Tooltip content="Mark as Read">
                        <button
                            aria-label={`Mark ${session.displayTitle} as read`}
                            aria-keyshortcuts="Delete"
                            className={cn(
                                sessionRowActionButton,
                                'agent-activity-mark-read absolute top-1/2 right-1 z-10 -translate-y-1/2 opacity-0 transition-opacity group-hover/activity-row:opacity-100 focus-visible:opacity-100',
                            )}
                            tabIndex={-1}
                            type="button"
                            onClick={(event) => {
                                event.stopPropagation();
                                onMarkRead();
                            }}
                        >
                            <Check aria-hidden="true" size={12} />
                        </button>
                    </Tooltip>
                )}
            </div>
        </SessionRowMenu>
    );
}
