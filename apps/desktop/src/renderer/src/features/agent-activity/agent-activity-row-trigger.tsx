import type { ComponentType } from 'react';

import type { ProjectRecord, SessionPullRequest } from '@caxri/protocol';
import {
    Circle,
    CircleCheck,
    CircleDashed,
    CircleQuestionMark,
    CircleX,
    Unplug,
} from 'lucide-react';

import { Spinner } from '../../components/ui/spinner';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { WorktreeIcon } from '../../icons/codicons/worktree-icon';
import { cn } from '../../lib/utilities';
import type { SessionRenameController } from '../primary-sidebar/hooks/use-session-rename';
import type { SessionTitleScroll } from '../primary-sidebar/hooks/use-session-title-scroll';
import { SessionPullRequestIndicator } from '../primary-sidebar/session-pull-request-indicator';
import { didSelectSession } from '../session/session-commands';
import type { AgentActivityGlyphId } from './agent-activity-glyph';
import { agentActivityGlyph } from './agent-activity-glyph';
import { AgentActivityRowTitle } from './agent-activity-row-title';
import type { AgentActivityRow } from './agent-activity-rows';

/**
 * The shape that renders each Activity state.
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
 * Returns the DOM trigger so HoverCardTrigger can attach its event handlers and ref directly.
 */
export function AgentActivityRowTrigger({
    beginRename,
    canMarkRead,
    isRenaming,
    onFocusChange,
    onMarkRead,
    relativeTime,
    roving,
    row,
    selected,
    sessionRename,
    titleScroll,
    visiblePullRequest,
    worktreeProject,
}: {
    beginRename: () => void;
    canMarkRead: boolean;
    isRenaming: boolean;
    onFocusChange: (rowId: string) => void;
    onMarkRead: () => void;
    relativeTime: string | undefined;
    roving: boolean;
    row: AgentActivityRow;
    selected: boolean;
    sessionRename: SessionRenameController;
    /**
     * Owned by the caller: this is a plain function returning the HoverCard trigger element, not a component, so it
     * must not call hooks — React Compiler may skip re-running it and React would see a changed hook count.
     */
    titleScroll: SessionTitleScroll;
    visiblePullRequest: SessionPullRequest | undefined;
    worktreeProject: ProjectRecord | undefined;
}) {
    const { project, session, terminal } = row;
    const glyph = agentActivityGlyph(row);
    const GlyphIcon = GLYPH_COMPONENTS[glyph.id];
    const { viewportReference, textReference, setHovered, setFocused } = titleScroll;
    return (
        <div
            className={cn(
                'agent-activity-row relative flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-foreground',
                'hover:bg-[color-mix(in_srgb,var(--elevated)_60%,transparent)]',
                'focus-visible:ring-1 focus-visible:ring-foreground focus-visible:outline-none',
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
            aria-keyshortcuts={canMarkRead && !isRenaming ? 'Delete Backspace' : undefined}
            tabIndex={isRenaming ? undefined : roving ? 0 : -1}
            onBlur={() => setFocused(false)}
            onFocus={(event) => {
                onFocusChange(session.id);
                // `SessionRowTrigger` gates the title reveal on `:focus-visible` the same way, so a pointer click that
                // lands focus here does not also start scrolling the title.
                setFocused(event.currentTarget.matches(':focus-visible'));
            }}
            onClick={() => {
                // Fire-and-forget: the selection reports its own failures through a toast.
                // eslint-disable-next-line no-void -- intentional floating-promise discard
                if (!isRenaming && !selected) void didSelectSession(session.id);
            }}
            onDoubleClick={beginRename}
            onKeyDown={(event) => {
                if (isRenaming) return;
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
                <AgentActivityRowTitle
                    isRenaming={isRenaming}
                    onTitleHoverChange={setHovered}
                    sessionId={session.id}
                    sessionRename={sessionRename}
                    textReference={textReference}
                    title={session.displayTitle}
                    viewportReference={viewportReference}
                />
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
                        <span className="agent-activity-project overflow-fade max-w-[calc(100%-1rem)] min-w-0 shrink-0">
                            {project.displayTitle}
                        </span>
                        {worktreeProject && (
                            <span
                                className="agent-activity-worktree flex min-w-0 shrink items-center gap-0.5"
                                data-session-worktree={worktreeProject.displayTitle}
                            >
                                <WorktreeIcon className="flex-none" size={11} />
                                <span className="overflow-fade">
                                    {worktreeProject.displayTitle}
                                </span>
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
            <AgentActivityPullRequestSlot
                hidesOnHover={canMarkRead}
                pullRequest={visiblePullRequest}
            />
        </div>
    );
}

/**
 * The pull request glyph sits in a right-edge slot centered on the whole two-line row, not on the title line: pinned to
 * the title it floated in the top-right corner, detached from the metadata it describes. Only a pull request reserves
 * the slot. The mark-read button overlays the right edge instead, because a slot reserved for a hover-only action would
 * cost every unread row the width its Project name needs at the side bar's minimum width; the glyph hides while that
 * button shows.
 */
function AgentActivityPullRequestSlot({
    hidesOnHover,
    pullRequest,
}: {
    hidesOnHover: boolean;
    pullRequest: SessionPullRequest | undefined;
}) {
    if (!pullRequest) return null;
    return (
        <span className="agent-activity-trailing flex w-5 flex-none justify-end">
            <SessionPullRequestIndicator
                className={cn(
                    hidesOnHover && 'transition-opacity group-hover/activity-row:opacity-0',
                )}
                pullRequest={pullRequest}
            />
        </span>
    );
}
