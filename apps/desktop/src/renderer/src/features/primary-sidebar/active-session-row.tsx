import { useState } from 'react';

import type { ProjectRecord, SessionRecord, TerminalRecord } from '@caxri/protocol';

import { useTranslation } from '../../i18n';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { cn } from '../../lib/utilities';
import { useIsSessionOpenElsewhere } from '../../stores/open-sessions';
import { BotSessionMarker } from '../caxri-bot/bot-session-marker';
import { useSessionLabel } from '../session/hooks/use-session-label';
import { sessionTitleForDisplay } from '../session/session-title';
import { SessionHostMark } from '../ssh-host/session-host-mark';
import type { SessionOrderController } from './hooks/use-session-order';
import { useSessionPullRequest } from './hooks/use-session-pull-request';
import { useSessionTitleScroll } from './hooks/use-session-title-scroll';
import { SessionActivityCard } from './session-activity-card';
import { SessionOpenLabel } from './session-open-label';
import { canSuggestSessionTitle } from './session-rename-draft';
import { SessionRenameInput } from './session-rename-input';
import { SessionRowActions } from './session-row-actions';
import { sessionRowDetail } from './session-row-detail';
import { SessionRowMenu } from './session-row-menu';
import { SessionRowStatus } from './session-row-status';
import { SessionRowTrigger } from './session-row-trigger';
import { SessionSubagentRows } from './session-subagent-rows';

interface ActiveSessionRowProperties {
    sessionOrder: SessionOrderController;
    /**
     * The title of the Session that created this one. Set only on a nested Session row, where the hover card's
     * description says `Delegated by <title>`.
     */
    delegatedBy?: string;
    /**
     * True for a nested Session whose delegation failed, which shows the red X in the status slot (see
     * `sessionStatus`). A primitive from the sidebar's single feed read, so no row subscribes to the feed itself.
     */
    delegationFailed?: boolean;
    /**
     * True on a row in the Pinned group, where the hover card's description opens with `In Pinned group.` and the
     * accessible description tells the row from a Project's. Independent of `showProjectName`, which a nested row sets
     * too.
     */
    inPinnedGroup?: boolean;
    /**
     * True for a Session nested under its host (level 3): a fixed child of the Session that created it, so it is not
     * draggable, not a drop target, has no `Alt+Arrow` reorder, and shows no subagent rows of its own.
     */
    nested?: boolean;
    /**
     * The rows this row's list shows, in order, for `Alt+Arrow` reordering.
     */
    visibleSessionIds: readonly string[];
    focusRenameInput: (element: HTMLInputElement | null) => void;
    /**
     * The list's shared handler; the row supplies its own Session and row id, so every row receives the same function.
     */
    onBeginRename: (sessionId: string, title: string, rowId: string) => void;
    onBlurRename: () => void;
    onCancelRename: () => void;
    onCommitRename: () => void;
    onRenameValueChange: (value: string) => void;
    onSuggestRename: (sessionId: string, title: string, rowId: string) => void;
    /**
     * The owning Project's title, icon, id, and root, passed as fields rather than as its record. The record is
     * replaced whenever the Project's `lastVisitedAt` moves, which every Session switch inside it does, and a record
     * prop would render every row of that Project again for a timestamp no row shows (issue #1356).
     */
    projectTitle: string;
    projectIcon: ProjectRecord['icon'];
    projectId: string;
    projectRootPath: string;
    /**
     * Names the owning Project beside the title. Set where a row is not under its own Project's heading: the Pinned
     * group, where rows arrive from several Projects at once, and a nested Session, which sits under its host's
     * Project. The title alone no longer says which one this is.
     */
    showProjectName?: boolean;
    /**
     * Marks the SSH Host the Session runs on beside its title, for a row whose heading does not say it: a repository
     * merged across machines, and every row that names its Project. This Mac's rows stay unmarked. The mark is
     * icon-only, as Orca and Superset mark a remote workspace row, so it never costs the title its width.
     */
    showHostMark?: boolean;
    renameError?: string;
    renameSuggesting: boolean;
    renameValue: string;
    renaming: boolean;
    /**
     * True when this Session row currently owns the tree's single roving Tab stop.
     */
    roving: boolean;
    /**
     * The row's id in the tree. Defaults to the Session id; the Pinned group and a nested row pass a namespaced one
     * (`pinned-session:<id>`, `delegated-session:<id>`), so a row id says which list it sits in.
     */
    rowId?: string;
    selected: boolean;
    session: SessionRecord;
    /**
     * The Switch to Pinned Session chord to show in place of the row's status while its modifier is held. Pinned group
     * only.
     */
    shortcutHint?: string;
    /**
     * Whether Chat Sessions list their subagents under the row (`primarySidebar.showSubagents`).
     */
    showSubagents?: boolean;
    /**
     * The roving row id when it is one of this Session's subagent rows, so a focus move elsewhere keeps this memo.
     */
    subagentRovingRowId?: string;
    terminal?: TerminalRecord;
    /**
     * Workbench Root Project when this Session works in a linked worktree instead of its own Project root. Absent for
     * the ordinary case, which renders no marker.
     */
    worktreeProject?: ProjectRecord;
}

/**
 * A trailing glyph's slot collapses while the pointer is over the row, so Pin and Archive are the only things on the
 * right edge then.
 */
const HIDDEN_ON_ROW_HOVER =
    'group-hover/session-row:w-0 group-hover/session-row:min-w-0 group-hover/session-row:overflow-hidden';

/**
 * One active Session row, shared by the Project groups, the Pinned group, and a host's nested Sessions. Everything that
 * varies between them (its tree row id, whether the owning Project is named, whether it is nested) is a prop rather
 * than a second component: two row implementations would drift, and this row already carries the drag source, the hover
 * card, the context menu, and the tree semantics.
 *
 * Every list renders it through `MemoizedActiveSessionRow` (`memoized-active-session-row.ts`). Each list renders its
 * rows from one `.map()`, which React Compiler caches as a whole, so any change to the list's inputs (a Session switch
 * moves the selection and replaces the opened Session's record) recreates every row element. The memo boundary lets a
 * row whose props kept their identity skip rendering, which on a switch is every row but the two whose selection moved,
 * and its props are shaped for exactly that: shared handlers, an id list keyed by content, and the Project as fields
 * (issue #1356). A new prop derived per render from a list or a record would quietly undo it, which is why a nested
 * row's failure and creator title arrive as a boolean and a string rather than as the delegation feed they came from.
 */
export function ActiveSessionRow({
    sessionOrder,
    delegatedBy,
    delegationFailed,
    inPinnedGroup,
    nested,
    visibleSessionIds,
    focusRenameInput,
    onBeginRename,
    onBlurRename,
    onCancelRename,
    onCommitRename,
    onRenameValueChange,
    onSuggestRename,
    projectTitle,
    projectIcon,
    projectId,
    projectRootPath,
    showProjectName,
    showHostMark,
    renameError,
    renameSuggesting,
    renameValue,
    renaming,
    roving,
    rowId,
    selected,
    session,
    shortcutHint,
    showSubagents = false,
    subagentRovingRowId,
    terminal,
    worktreeProject,
}: ActiveSessionRowProperties) {
    const { t } = useTranslation();
    const title = sessionTitleForDisplay(session.title, t);
    // The shared label rule (collision suffix included); `title` above stays the plain stored title for rename and the
    // tree row's accessible name.
    const label = useSessionLabel(session.id);
    const detail = sessionRowDetail(label.suffix, projectTitle, showProjectName === true);
    // Read per row as a primitive, so another window's navigation re-renders only the rows it concerns.
    const isOpenElsewhere = useIsSessionOpenElsewhere(session.id);
    const project = {
        title: projectTitle,
        icon: projectIcon,
        id: projectId,
        rootPath: projectRootPath,
    };
    const beginRename = (): void => {
        onBeginRename(session.id, session.title, rowId ?? session.id);
    };
    const suggestRename = (): void => {
        onSuggestRename(session.id, session.title, rowId ?? session.id);
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
        label.title,
        renaming || menuOpen,
    );
    const sessionCard = (
        <SessionRowTrigger
            session={session}
            rowId={rowId}
            nested={nested}
            selected={selected}
            renaming={renaming}
            roving={roving}
            sessionOrder={sessionOrder}
            visibleSessionIds={visibleSessionIds}
            onBeginRename={beginRename}
            onSuggestRename={suggestRename}
            onFocusChange={setFocused}
        >
            {/* A plain brand-color mark: its color is what tells Agents apart; lifecycle lives at the right edge. */}
            <AgentIdentityIcon identity={terminal?.kind ?? 'shell'} size={14} />
            {renaming ? (
                <SessionRenameInput
                    sessionId={session.id}
                    title={title}
                    error={renameError}
                    value={renameValue}
                    focusInput={focusRenameInput}
                    onBlur={onBlurRename}
                    onChange={onRenameValueChange}
                    onCommit={onCommitRename}
                    onCancel={onCancelRename}
                    onSuggest={suggestRename}
                    canSuggest={canSuggestSessionTitle(session)}
                    suggesting={renameSuggesting}
                />
            ) : (
                <span className="session-copy overflow-fade flex min-w-0 flex-1 items-center gap-1 [--overflow-fade-size:16px]">
                    <strong
                        ref={viewportReference}
                        /*
                         * `flex-none` with `max-w-full` is what makes the title win the row. Both items were
                         * shrinkable before, and flexbox shrinks in proportion to each item's own width, so a long
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
                            {label.title}
                        </span>
                    </strong>
                    {/* Muted disambiguation, shown only when another Session carries the same title. */}
                    {detail.suffix && (
                        <span
                            aria-hidden="true"
                            className="session-label-detail min-w-0 flex-none overflow-hidden text-[11px] whitespace-nowrap text-muted"
                        >
                            {detail.suffix}
                        </span>
                    )}
                    <SessionHostMark isShown={showHostMark} sessionId={session.id} />
                    <SessionOpenLabel isOpenElsewhere={isOpenElsewhere} />
                    {/*
                     * `aria-hidden` because the row's accessible name is composed elsewhere and would otherwise read
                     * the Project twice; the hover card names it for anyone who needs the full sentence. Allowed to
                     * shrink to nothing so a long Session title still wins the row.
                     */}
                    {detail.showProjectName && (
                        <span
                            aria-hidden="true"
                            className="session-project min-w-0 flex-1 basis-0 overflow-hidden text-[11px] whitespace-nowrap text-muted"
                        >
                            {projectTitle}
                        </span>
                    )}
                </span>
            )}
            {/*
             * Outside the title's span, whose overflow fade would hide a glyph after a long title. Absent for the
             * ordinary Session Caxri Bot does not manage, so it costs no width there.
             */}
            {!renaming && (
                <BotSessionMarker className={HIDDEN_ON_ROW_HOVER} sessionId={session.id} />
            )}
            {/*
             * On pointer hover every glyph steps aside for Pin/Archive (~42px): its slot collapses entirely, because a
             * 14px ghost track would still let the title paint through those buttons, and a glyph squeezed in beside
             * them read as a third, unlabeled action.
             */}
            <SessionRowStatus
                className={HIDDEN_ON_ROW_HOVER}
                delegationFailed={delegationFailed}
                pullRequest={pullRequestUnavailable ? undefined : pullRequest}
                renaming={renaming}
                renameSuggesting={renameSuggesting}
                session={session}
                shortcutHint={shortcutHint}
                terminal={terminal}
            />
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
                    delegatedBy={delegatedBy}
                    delegationFailed={delegationFailed}
                    inPinnedGroup={inPinnedGroup}
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
            {/* The editor's own AI button takes the right edge while renaming; hover actions would cover it. */}
            {!renaming && <SessionRowActions session={session} />}
        </div>
    );
    // A nested Session lists no subagents: a delegation chain is one level deep, and the host's group stays short.
    const subagentRows = nested ? null : (
        <SessionSubagentRows
            rovingRowId={subagentRovingRowId}
            sessionId={session.id}
            showSubagents={showSubagents}
            terminal={terminal}
        />
    );
    if (renaming)
        return (
            <>
                {row}
                {subagentRows}
            </>
        );
    return (
        <>
            <SessionRowMenu
                onBeginRename={beginRename}
                onSuggestRename={suggestRename}
                onOpenChange={setMenuOpen}
                project={project}
                pullRequest={pullRequest}
                session={session}
            >
                {row}
            </SessionRowMenu>
            {subagentRows}
        </>
    );
}
