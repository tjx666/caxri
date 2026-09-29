import { useState } from 'react';

import type { ProjectRecord, SessionRecord, TerminalRecord } from '@caxri/protocol';

import { cn } from '../../lib/utilities';
import type { SessionOrderController } from './hooks/use-session-order';
import { useSessionPullRequest } from './hooks/use-session-pull-request';
import { useSessionTitleScroll } from './hooks/use-session-title-scroll';
import { SessionActivityCard } from './session-activity-card';
import { SessionAgentStatusIcon } from './session-agent-status-icon';
import { SessionPullRequestIndicator } from './session-pull-request-indicator';
import { SessionRenameInput } from './session-rename-input';
import { SessionRowActions } from './session-row-actions';
import { SessionRowMenu } from './session-row-menu';
import { SessionRowTrigger } from './session-row-trigger';
import { SessionStatusLine } from './session-status-line';

interface ActiveSessionRowProperties {
    sessionOrder: SessionOrderController;
    /**
     * The rows this row's list shows, in order, for `Alt+Arrow` reordering.
     */
    visibleSessionIds: readonly string[];
    focusRenameInput: (element: HTMLInputElement | null) => void;
    /**
     * The list's shared handler; the row supplies its own Session and row id, so every row receives the same function.
     */
    onBeginRename: (sessionId: string, displayTitle: string, rowId: string) => void;
    onBlurRename: () => void;
    onCancelRename: () => void;
    onCommitRename: () => void;
    onRenameValueChange: (value: string) => void;
    /**
     * The owning Project's title, icon, id, and root — passed as fields rather than as its record. The record is
     * replaced whenever the Project's `lastOpenedAt` moves, which every Session switch inside it does, and a record
     * prop would render every row of that Project again for a timestamp no row shows (issue #1356).
     */
    projectDisplayTitle: string;
    projectIcon: ProjectRecord['icon'];
    projectId: string;
    projectRootPath: string;
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
}

/**
 * One active Session row, shared by the Project groups and the Pinned group. A pinned Session is rendered twice — once
 * in each — so everything that varies between the two copies (its tree row id, whether the owning Project is named) is
 * a prop rather than a second component: two row implementations would drift, and this row already carries the drag
 * source, the hover card, the context menu, and the tree semantics.
 *
 * Both lists render it through `memo`. Each list renders its rows from one `.map()`, which React Compiler caches as a
 * whole, so any change to the list's inputs — a Session switch moves the selection and replaces the opened Session's
 * record — recreates every row element. The memo boundary lets a row whose props kept their identity skip rendering,
 * which on a switch is every row but the two whose selection moved, and its props are shaped for exactly that: shared
 * handlers, an id list keyed by content, and the Project as fields (issue #1356). A new prop derived per render from a
 * list or a record would quietly undo it.
 */
export function ActiveSessionRow({
    sessionOrder,
    visibleSessionIds,
    focusRenameInput,
    onBeginRename,
    onBlurRename,
    onCancelRename,
    onCommitRename,
    onRenameValueChange,
    projectDisplayTitle,
    projectIcon,
    projectId,
    projectRootPath,
    showProjectName,
    renameError,
    renameValue,
    renaming,
    roving,
    rowId,
    selected,
    session,
    terminal,
    terminals,
    worktreeProject,
}: ActiveSessionRowProperties) {
    const project = {
        displayTitle: projectDisplayTitle,
        icon: projectIcon,
        id: projectId,
        rootPath: projectRootPath,
    };
    const beginRename = (): void => {
        onBeginRename(session.id, session.displayTitle, rowId ?? session.id);
    };
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
            visibleSessionIds={visibleSessionIds}
            onBeginRename={beginRename}
            onFocusChange={setFocused}
        >
            {/*
             * The Agent's lifecycle rides on its own icon; the trailing track keeps only delivery state. Both sit in a
             * box one title line tall, so they stay beside the title rather than centering on the two-line row.
             */}
            <span className="flex h-5 flex-none items-center">
                <SessionAgentStatusIcon session={session} terminal={terminal} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
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
                    <span className="flex h-5 min-w-0 items-center gap-2">
                        <span className="session-copy overflow-fade flex h-5 min-w-0 flex-1 items-center gap-1">
                            <strong
                                ref={viewportReference}
                                /*
                                 * `flex-none` with `max-w-full` is what makes the title win the row. Both items were
                                 * shrinkable before, and flexbox shrinks in proportion to each item's own width — so a
                                 * long Project name took the larger share of the row and clipped an eight-character
                                 * Session title down to two, which reads as the Project name covering the title rather
                                 * than as either one being truncated. The title now claims its natural width up to the
                                 * whole row, and the Project name takes whatever is left.
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
                             * `aria-hidden` because the row's accessible name is composed elsewhere and would otherwise
                             * read the Project twice; the hover card names it for anyone who needs the full sentence.
                             * Allowed to shrink to nothing so a long Session title still wins the row.
                             */}
                            {showProjectName && (
                                <span
                                    aria-hidden="true"
                                    className="session-project min-w-0 flex-1 basis-0 overflow-hidden text-[11px] whitespace-nowrap text-muted"
                                >
                                    {projectDisplayTitle}
                                </span>
                            )}
                        </span>
                        {/*
                         * Delivery state only: the pull request and its production deployment. Agent lifecycle lives on
                         * the leading icon, so a running or unread Session no longer hides its pull request. The
                         * wrapper follows the glyph's width, so a Session with no PR gives the empty 14px track back to
                         * its title while every visible glyph lands on the same right edge. Pointer hover collapses the
                         * track entirely: Pin/Archive need ~42px, and a 14px ghost track would still let the title
                         * paint through those glyphs. The track sits inside the title line rather than in a column of
                         * its own, so it shares a right edge with the status line's trailing `+N -M` below it.
                         */}
                        <span className="session-indicators flex h-5 flex-none items-center justify-end group-hover/session-row:w-0 group-hover/session-row:min-w-0 group-hover/session-row:overflow-hidden">
                            <SessionPullRequestIndicator
                                className="transition-opacity group-hover/session-row:opacity-0"
                                pullRequest={pullRequestUnavailable ? undefined : pullRequest}
                            />
                        </span>
                    </span>
                )}
                <SessionStatusLine session={session} terminal={terminal} />
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
            onBeginRename={beginRename}
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
