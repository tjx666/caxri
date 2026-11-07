import type { KeyboardEvent } from 'react';

import type { AgentExcerpt, ProjectRecord, SessionPullRequest } from '@caxri/protocol';
import { FolderTree, Sparkles } from 'lucide-react';

import type { Translate } from '../../i18n';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { cn } from '../../lib/utilities';
import type { SessionRenameController } from '../primary-sidebar/hooks/use-session-rename';
import type { SessionTitleScroll } from '../primary-sidebar/hooks/use-session-title-scroll';
import { SessionPullRequestIndicator } from '../primary-sidebar/session-pull-request-indicator';
import { canSuggestSessionTitle } from '../primary-sidebar/session-rename-draft';
import { didSelectSession } from '../session/session-commands';
import { sessionTitleForDisplay } from '../session/session-title';
import { AgentActivityRowTitle } from './agent-activity-row-title';
import type { AgentActivityRow } from './agent-activity-rows';
import type { AgentActivityStatusNote } from './agent-activity-status-note';
import { agentActivityStatusNote } from './agent-activity-status-note';

/**
 * The row's own keys for `aria-keyshortcuts`: `Shift+Enter` names it with AI when the Session has an Agent to ask, and
 * Delete marks it Done where the Session has Pending Attention. None while the rename editor replaces the row.
 */
function rowKeyShortcuts({
    canMarkDone,
    canSuggest,
    isRenaming,
}: {
    canMarkDone: boolean;
    canSuggest: boolean;
    isRenaming: boolean;
}): string | undefined {
    if (isRenaming) return undefined;
    const keys = [canSuggest && 'Shift+Enter', canMarkDone && 'Delete Backspace'].filter(Boolean);
    return keys.length > 0 ? keys.join(' ') : undefined;
}

/**
 * The shape that leads a waiting or failed row's metadata line (`?` for a question, a cross for a failure), so the
 * state never rests on color alone and stays visible when the line is too narrow for the phrase.
 */
function StatusMark({ note }: { note: 'failed' | 'waiting' }) {
    return (
        <span
            aria-hidden="true"
            className={cn(
                'agent-activity-mark flex-none font-semibold',
                note === 'waiting' ? 'text-warning' : 'text-danger',
            )}
            data-activity-mark={note}
        >
            {note === 'waiting' ? '?' : '✕'}
        </span>
    );
}

/**
 * The metadata line's state phrase. `background` is plain text: a Session watching background work is not asking
 * anything.
 */
function StatusNote({ note, t }: { note: AgentActivityStatusNote; t: Translate }) {
    const label = t(
        note === 'background'
            ? 'agentActivity.note.background'
            : `primarySidebar.activity.${note}.label`,
    );
    return (
        <span
            className={cn(
                'agent-activity-note whitespace-nowrap',
                note === 'waiting' && 'text-warning',
                note === 'failed' && 'text-danger',
            )}
            data-activity-note={note}
        >
            {label}
        </span>
    );
}

/**
 * The row's own keys once the rename editor is closed.
 */
function handleRowKeyDown(
    event: KeyboardEvent<HTMLDivElement>,
    {
        canMarkDone,
        canSuggest,
        onMarkDone,
        onSelect,
        onSuggest,
    }: {
        canMarkDone: boolean;
        canSuggest: boolean;
        onMarkDone: () => void;
        onSelect: () => void;
        onSuggest: () => void;
    },
): void {
    // The Project tree's `Shift+Enter`: open the editor and ask for an AI-generated name.
    if (event.key === 'Enter' && event.shiftKey) {
        event.preventDefault();
        if (canSuggest) onSuggest();
        return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onSelect();
        return;
    }
    /*
     * Delete resolves the item here rather than archiving the Session, which is what the same key does in the
     * PrimarySidebar. The two lists answer different questions: that one is "which Sessions exist", this one is "what is
     * still on my plate", and removing an item from a queue is what Delete means in a queue. `aria-keyshortcuts`
     * announces it, and the row's own check button offers the same action.
     */
    if (canMarkDone && (event.key === 'Delete' || event.key === 'Backspace')) {
        event.preventDefault();
        onMarkDone();
    }
}

/**
 * Returns the DOM trigger so HoverCardTrigger can attach its event handlers and ref directly.
 */
export function AgentActivityRowTrigger({
    beginRename,
    canMarkDone,
    isRenaming,
    onFocusChange,
    onMarkDone,
    excerpt,
    relativeTime,
    roving,
    row,
    selected,
    sessionRename,
    showExcerpts,
    t,
    titleScroll,
    visiblePullRequest,
    worktreeProject,
}: {
    beginRename: () => void;
    /**
     * The Session has Pending Attention, so Delete resolves it; see `onMarkDone`.
     */
    canMarkDone: boolean;
    isRenaming: boolean;
    onFocusChange: (rowId: string) => void;
    /**
     * Resolves the row's Pending Attention without opening it.
     */
    onMarkDone: () => void;
    relativeTime: string | undefined;
    /**
     * What the Agent last asked or said, clamped to two lines under the metadata. User content: shown locally only.
     */
    excerpt: AgentExcerpt | undefined;
    roving: boolean;
    row: AgentActivityRow;
    selected: boolean;
    sessionRename: SessionRenameController;
    /**
     * `agentActivity.showExcerpts`: with excerpts hidden, a waiting or failed row says so on its metadata line instead.
     */
    showExcerpts: boolean;
    /**
     * The caller's `useTranslation()` function, passed in for the same reason as `titleScroll`: this cannot call hooks.
     */
    t: Translate;
    /**
     * Owned by the caller: this is a plain function returning the HoverCard trigger element, not a component, so it
     * must not call hooks; React Compiler may skip re-running it and React would see a changed hook count.
     */
    titleScroll: SessionTitleScroll;
    visiblePullRequest: SessionPullRequest | undefined;
    worktreeProject: ProjectRecord | undefined;
}) {
    const { project, session, terminal } = row;
    const canSuggest = canSuggestSessionTitle(session);
    const { viewportReference, textReference, setHovered, setFocused } = titleScroll;
    /**
     * `AgentActivityRowItem` overlays the Mark as Done check on the trailing slot, so the slot must exist whenever the
     * check can show, even on a row without a pull request.
     */
    const offersMarkDone = canMarkDone && !isRenaming;
    const note = agentActivityStatusNote(row, showExcerpts);
    return (
        <div
            className={cn(
                'agent-activity-row relative flex w-full cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-left text-foreground',
                'hover:bg-state-hover',
                'focus-visible:ring-1 focus-visible:ring-foreground focus-visible:outline-none',
                selected && 'active bg-elevated',
            )}
            data-activity-group={row.groupId}
            data-row-id={row.rowId}
            data-session-id={session.id}
            role="treeitem"
            aria-level={2}
            aria-selected={selected}
            aria-keyshortcuts={rowKeyShortcuts({ canMarkDone, canSuggest, isRenaming })}
            tabIndex={isRenaming ? undefined : roving ? 0 : -1}
            onBlur={() => setFocused(false)}
            onFocus={(event) => {
                onFocusChange(row.rowId);
                // `SessionRowTrigger` gates the title reveal on `:focus-visible` the same way, so a pointer click that
                // lands focus here does not also start scrolling the title.
                setFocused(event.currentTarget.matches(':focus-visible'));
            }}
            onClick={() => {
                // Fire-and-forget: the selection reports its own failures through a toast.
                if (!isRenaming && !selected) void didSelectSession(session.id);
            }}
            onDoubleClick={beginRename}
            onKeyDown={(event) => {
                if (isRenaming) return;
                handleRowKeyDown(event, {
                    canMarkDone,
                    canSuggest,
                    onMarkDone,
                    onSelect: () => {
                        // Fire-and-forget: the selection reports its own failures through a toast.
                        if (!selected) void didSelectSession(session.id);
                    },
                    onSuggest: () =>
                        sessionRename.suggestRename(session.id, session.title, row.rowId),
                });
            }}
        >
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <AgentActivityRowTitle
                    canSuggest={canSuggest}
                    isRenaming={isRenaming}
                    isUnread={session.hasUnread}
                    onTitleHoverChange={setHovered}
                    rowId={row.rowId}
                    sessionId={session.id}
                    sessionRename={sessionRename}
                    textReference={textReference}
                    title={sessionTitleForDisplay(session.title, t)}
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
                    {/*
                     * A waiting or failed mark leads the line inside the location's flex item, so it never wraps out of
                     * the clipped line. The phrase follows the location and the time comes last: on a narrow line the
                     * time drops first, then the phrase, while the mark and the Project stay.
                     */}
                    <span className="agent-activity-lead-group flex h-4 max-w-full min-w-0 items-center gap-1.5">
                        {(note === 'waiting' || note === 'failed') && <StatusMark note={note} />}
                        <span className="agent-activity-location flex h-4 max-w-full min-w-0 items-center gap-1">
                            <span className="flex size-3 flex-none items-center justify-center">
                                <AgentIdentityIcon identity={terminal?.kind ?? 'shell'} size={12} />
                            </span>
                            {/*
                             * `pr-2` reserves the mask's own 8px fade distance as trailing padding, not text: `.overflow-fade`
                             * fades the box's last 8px unconditionally (see `styles.css`), and this box is `shrink-0` (sized
                             * to content, not a flex-1 "wider than content" box like the Project tree's), so without the
                             * padding a short, un-clipped Project name had its own last pixels faded for no reason
                             * (github.com/tjx666/caxri/issues/1173). The padding is inside `max-w`, so a Project long enough
                             * to hit the cap still clips at that same edge; this only changes the short-name case.
                             */}
                            <span className="agent-activity-project overflow-fade max-w-[calc(100%-1rem)] min-w-0 shrink-0 pr-2">
                                {project.title}
                            </span>
                            {worktreeProject && (
                                <span
                                    className="agent-activity-worktree flex min-w-0 shrink items-center gap-0.5"
                                    data-session-worktree={worktreeProject.title}
                                >
                                    <FolderTree className="flex-none" size={11} />
                                    {/* Same reserved-padding reasoning as `.agent-activity-project` above. */}
                                    <span className="overflow-fade pr-2">
                                        {worktreeProject.title}
                                    </span>
                                </span>
                            )}
                        </span>
                    </span>
                    {note && (
                        <span className="agent-activity-note-group flex flex-none gap-1.5">
                            <span aria-hidden="true">·</span>
                            <StatusNote note={note} t={t} />
                        </span>
                    )}
                    {relativeTime && (
                        <span className="agent-activity-time flex flex-none gap-1.5 whitespace-nowrap">
                            <span aria-hidden="true">·</span>
                            <span>{relativeTime}</span>
                        </span>
                    )}
                </span>
                {showExcerpts && excerpt && (
                    <span
                        className="agent-activity-excerpt line-clamp-2 text-[11px] leading-4 wrap-break-word text-muted"
                        data-excerpt-kind={excerpt.kind}
                    >
                        {/* A recap is the Agent's own summary rather than a quote, so it carries a glyph and a spoken label. */}
                        {excerpt.kind === 'recap' && (
                            <>
                                <Sparkles
                                    aria-hidden="true"
                                    className="mr-1 inline-block align-[-1px]"
                                    size={10}
                                />
                                <span className="sr-only">{t('agentActivity.recapLabel')}</span>
                            </>
                        )}
                        {excerpt.text}
                    </span>
                )}
            </span>
            {(visiblePullRequest !== undefined || offersMarkDone) && (
                /*
                 * The pull request glyph sits in a right-edge slot centered on the whole two-line row, not on the title
                 * line: pinned to the title it floated in the top-right corner, detached from the metadata it
                 * describes. The Mark as Done check takes the same spot on hover, focus, and selection, where the
                 * Project tree keeps its row hover actions. Without a pull request the slot only appears while the check
                 * shows, so the title gives up that width only when the check needs it.
                 */
                <span
                    className={cn(
                        'agent-activity-trailing flex w-5 flex-none items-center justify-end self-stretch',
                        !visiblePullRequest &&
                            !selected &&
                            'hidden group-focus-within/activity-row:flex group-hover/activity-row:flex',
                    )}
                >
                    {visiblePullRequest && (
                        <span
                            className={cn(
                                'flex',
                                offersMarkDone &&
                                    'transition-opacity group-focus-within/activity-row:opacity-0 group-hover/activity-row:opacity-0',
                                offersMarkDone && selected && 'opacity-0',
                            )}
                        >
                            <SessionPullRequestIndicator pullRequest={visiblePullRequest} />
                        </span>
                    )}
                </span>
            )}
        </div>
    );
}
