import { useState } from 'react';

import type { ProjectRecord, SessionRecord, TerminalRecord } from '@caxri/protocol';

import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { WorktreeIcon } from '../../icons/codicons/worktree-icon';
import { cn } from '../../lib/utilities';
import type { SessionOrderController } from './hooks/use-session-order';
import { useSessionPullRequest } from './hooks/use-session-pull-request';
import { useSessionTitleScroll } from './hooks/use-session-title-scroll';
import { SessionActivityCard } from './session-activity-card';
import { SessionPullRequestIndicator } from './session-pull-request-indicator';
import { SessionRenameInput } from './session-rename-input';
import { SessionRowActions } from './session-row-actions';
import { SessionRowMenu } from './session-row-menu';
import { SessionRowTrigger } from './session-row-trigger';
import { SessionStatusIndicator } from './session-status-indicator';

interface ActiveSessionRowProperties {
    sessionOrder: SessionOrderController;
    visibleSessions: readonly SessionRecord[];
    focusRenameInput: (element: HTMLInputElement | null) => void;
    onBeginRename: () => void;
    onBlurRename: () => void;
    onCancelRename: () => void;
    onCommitRename: () => void;
    onRenameValueChange: (value: string) => void;
    project: ProjectRecord;
    /**
     * Names the owning Project beside the title, and tells assistive technology which copy of a doubly listed Session
     * this row is. Set only in the Pinned group, where rows arrive from several Projects at once and the title alone no
     * longer says which one this is.
     */
    showProjectName?: boolean;
    renameError?: string;
    renameValue: string;
    renaming: boolean;
    /**
     * True when this Session row currently owns the tree's single roving Tab stop.
     */
    roving: boolean;
    /**
     * The row's id in the tree. Defaults to the Session id; the Pinned group passes a namespaced one because the same
     * Session also has a row under its own Project.
     */
    rowId?: string;
    selected: boolean;
    session: SessionRecord;
    terminal?: TerminalRecord;
    terminals: TerminalRecord[];
    /**
     * Workbench Root Project when this Session works in a linked worktree instead of its own Project root. Absent for
     * the ordinary case, which renders no marker.
     */
    worktreeProject?: ProjectRecord;
    /**
     * True when a sibling Session in this group carries a worktree marker, so this row holds the empty column that
     * keeps every marker on one vertical line. Reserved per group rather than globally: a Project with no worktree
     * Session would otherwise pay the indent for a column that is always blank.
     */
    reserveWorktreeSlot?: boolean;
}

/**
 * One active Session row, shared by the Project groups and the Pinned group. A pinned Session is rendered twice — once
 * in each — so everything that varies between the two copies (its tree row id, whether the owning Project is named) is
 * a prop rather than a second component: two row implementations would drift, and this row already carries the drag
 * source, the hover card, the context menu, and the tree semantics.
 */
export function ActiveSessionRow({
    sessionOrder,
    visibleSessions,
    focusRenameInput,
    onBeginRename,
    onBlurRename,
    onCancelRename,
    onCommitRename,
    onRenameValueChange,
    project,
    showProjectName,
    renameError,
    renameValue,
    renaming,
    reserveWorktreeSlot,
    roving,
    rowId,
    selected,
    session,
    terminal,
    terminals,
    worktreeProject,
}: ActiveSessionRowProperties) {
    /**
     * Read here rather than handed down from the sidebar root: the snapshot is refreshed on a timer, and a row that
     * takes its own slice stays quiet through every refresh that did not touch this Session.
     */
    const { pullRequest, unavailable: pullRequestUnavailable } = useSessionPullRequest(session.id);
    /**
     * The HoverCard opens on a hover delay and would otherwise pop over an open context menu; closing it while the menu
     * is open keeps one popup on screen at a time.
     */
    const [menuOpen, setMenuOpen] = useState(false);
    const { viewportReference, textReference, setHovered, setFocused } = useSessionTitleScroll(
        session.displayTitle,
        renaming || menuOpen,
    );
    const sessionCard = (
        <SessionRowTrigger
            session={session}
            rowId={rowId}
            selected={selected}
            renaming={renaming}
            roving={roving}
            sessionOrder={sessionOrder}
            visibleSessions={visibleSessions}
            onBeginRename={onBeginRename}
            onFocusChange={setFocused}
        >
            {reserveWorktreeSlot && (
                /*
                 * A leading fixed-width column, so every worktree marker in this group lands on one vertical line
                 * instead of trailing whichever title happened to be shortest. It sits outside the
                 * `.session-indicators` track at the row's other end, which grows only when one status glyph exists.
                 *
                 * VS Code's `worktree` codicon — a branch splitting off a trunk — rather than a second folder glyph.
                 * `FolderGit2` and `FolderSymlink` both read as one more folder mark next to the violet pull request
                 * glyph 14px away. What the marker says is that this Session works in a linked worktree, and the
                 * codicon is the mark the user already reads that way elsewhere. The status bar's Workbench Root
                 * picker swaps to the same codicon under the same condition (`workbench-root-picker.tsx`), so one
                 * Session cannot read as a worktree here and as a plain root there; `FolderGit2` still means
                 * "Workbench Root" for every other root.
                 *
                 * Decorative on purpose: the row already opens the Session hover card, which names the worktree, and
                 * its accessible description carries the same sentence. A second hover popup on one row would compete
                 * with that card.
                 */
                <span
                    className="session-worktree flex size-3.5 flex-none items-center justify-center text-muted"
                    data-session-worktree={worktreeProject?.displayTitle}
                >
                    {worktreeProject && <WorktreeIcon aria-hidden="true" size={12} />}
                </span>
            )}
            {/* `tone="state"`: this is the Session row itself, so Claude Code/Codex must tint like every
                other Agent instead of keeping a fixed brand color. */}
            <AgentIdentityIcon identity={terminal?.kind ?? 'shell'} size={14} tone="state" />
            {renaming ? (
                <SessionRenameInput
                    sessionId={session.id}
                    title={session.displayTitle}
                    error={renameError}
                    value={renameValue}
                    focusInput={focusRenameInput}
                    onBlur={onBlurRename}
                    onChange={onRenameValueChange}
                    onCommit={onCommitRename}
                    onCancel={onCancelRename}
                />
            ) : (
                <span className="session-copy overflow-fade flex min-w-0 flex-1 items-center gap-1">
                    <strong
                        ref={viewportReference}
                        /*
                         * `flex-none` with `max-w-full` is what makes the title win the row. Both items were
                         * shrinkable before, and flexbox shrinks in proportion to each item's own width — so a long
                         * Project name took the larger share of the row and clipped an eight-character Session title
                         * down to two, which reads as the Project name covering the title rather than as either one
                         * being truncated. The title now claims its natural width up to the whole row, and the Project
                         * name takes whatever is left.
                         */
                        className="session-title max-w-full min-w-0 flex-none overflow-hidden font-medium whitespace-nowrap"
                        onPointerEnter={() => setHovered(true)}
                        onPointerLeave={() => setHovered(false)}
                    >
                        <span ref={textReference} className="block w-max max-w-full">
                            {session.displayTitle}
                        </span>
                    </strong>
                    {/*
                     * `aria-hidden` because the row's accessible name is composed elsewhere and would otherwise read
                     * the Project twice; the hover card names it for anyone who needs the full sentence. Allowed to
                     * shrink to nothing so a long Session title still wins the row.
                     */}
                    {showProjectName && (
                        <span
                            aria-hidden="true"
                            className="session-project min-w-0 flex-1 basis-0 overflow-hidden text-[11px] whitespace-nowrap text-muted"
                        >
                            {project.displayTitle}
                        </span>
                    )}
                </span>
            )}
            {/*
             * Lifecycle signals take priority over the PR. The wrapper follows the rendered glyph's width, so an idle
             * Session with no PR gives the otherwise invisible 14px slot back to its title; every visible glyph still
             * lands on the same right edge. The PR remains available from the hover card and menu while temporarily
             * hidden. Pointer hover collapses the slot entirely: Pin/Archive need ~42px, and leaving a 14px ghost
             * track would still let the title paint through those glyphs.
             */}
            <span className="session-indicators flex flex-none items-center justify-end group-hover/session-row:w-0 group-hover/session-row:min-w-0 group-hover/session-row:overflow-hidden">
                <SessionStatusIndicator
                    className="transition-opacity group-hover/session-row:opacity-0"
                    fallback={
                        !renaming && (
                            <SessionPullRequestIndicator
                                className="transition-opacity group-hover/session-row:opacity-0"
                                pullRequest={pullRequestUnavailable ? undefined : pullRequest}
                            />
                        )
                    }
                    session={session}
                    terminal={terminal}
                />
            </span>
        </SessionRowTrigger>
    );
    /*
     * Layout and the drop marker only. The `treeitem` role, `aria-level`, and `aria-selected` belong to
     * `SessionRowTrigger` inside, which is the element that owns the roving `tabIndex`: semantics on a wrapper that
     * focus never reaches describe nothing.
     */
    const row = (
        <div className="session-row group/session-row relative [--session-hover-actions:2.875rem]">
            {sessionOrder.dropTarget?.anchorSessionId === session.id && (
                <div
                    aria-hidden="true"
                    className={cn(
                        'session-drop-marker pointer-events-none absolute inset-x-0 z-10 h-0.5 bg-accent',
                        sessionOrder.dropTarget.placement === 'before' ? 'top-0' : 'bottom-0',
                    )}
                />
            )}
            {renaming ? (
                sessionCard
            ) : (
                <SessionActivityCard
                    inPinnedGroup={showProjectName}
                    project={project}
                    pullRequest={pullRequest}
                    pullRequestUnavailable={pullRequestUnavailable}
                    session={session}
                    suppressed={menuOpen || sessionOrder.draggedId !== undefined}
                    terminal={terminal}
                    trigger={sessionCard}
                    worktreeProject={worktreeProject}
                />
            )}
            <SessionRowActions session={session} />
        </div>
    );
    if (renaming) return row;
    return (
        <SessionRowMenu
            onBeginRename={onBeginRename}
            onOpenChange={setMenuOpen}
            project={project}
            pullRequest={pullRequest}
            session={session}
            terminals={terminals}
        >
            {row}
        </SessionRowMenu>
    );
}
