import { memo } from 'react';

import type { ProjectRecord, SessionRecord, TerminalRecord } from '@caxri/protocol';
import { ChevronDown, ChevronRight, Pin } from 'lucide-react';

import { DisclosureMotion } from '../../components/disclosure-motion';
import { Tooltip } from '../../components/ui/tooltip';
import { sessionAgentTerminal } from '../session/session-agent-terminal';
import { ActiveSessionRow } from './active-session-row';
import type { SessionOrderController } from './hooks/use-session-order';
import { useVisibleSessionIds } from './hooks/use-visible-session-ids';
import { focusDisclosureRow } from './primary-sidebar-focus';
import {
    PINNED_GROUP_ROW_ID,
    primarySidebarPinnedRowId,
    primarySidebarRevealRowId,
} from './primary-sidebar-tree';

const PINNED_DISCLOSURE_ID = 'pinned-sessions-group';

/**
 * Rows render through a memo boundary so a Session switch renders only the rows whose selection moved; the props this
 * list passes are shaped for it, as `ActiveSessionRow` explains (issue #1356).
 */
const MemoizedActiveSessionRow = memo(ActiveSessionRow);

interface PinnedSessionGroupProperties {
    animate: boolean;
    expanded: boolean;
    focusRenameInput: (element: HTMLInputElement | null) => void;
    /**
     * Pinned Sessions the window hides; a positive count puts the reveal row on screen.
     */
    hiddenSessionCount: number;
    nextRevealCount: number;
    onBeginRename: (sessionId: string, displayTitle: string, rowId: string) => void;
    onBlurRename: () => void;
    onCancelRename: () => void;
    onCommitRename: () => void;
    onSuggestRename: (sessionId: string, displayTitle: string, rowId: string) => void;
    onRenameValueChange: (value: string) => void;
    onRevealMoreSessions: () => void;
    onToggle: () => void;
    /**
     * Owning Project keyed by Session id. Every pinned Session needs one: the group spans Projects, so the row has to
     * say which one it came from, and the context menu's Project actions act on it.
     */
    projects: Record<string, ProjectRecord | undefined>;
    renameError?: string;
    renameSuggestingSessionId?: string;
    renameValue: string;
    renamingRowId?: string;
    /**
     * Id of the row that currently owns the tree's single roving Tab stop.
     */
    rovingRowId?: string;
    selectedSessionId?: string;
    sessionOrder: SessionOrderController;
    /**
     * Every pinned Session in Pinned order (frozen while dragging), window included, so the heading's count is the real
     * membership rather than what happens to be on screen.
     */
    sessions: SessionRecord[];
    terminals: TerminalRecord[];
    /**
     * The pinned Sessions the window currently renders.
     */
    visibleSessions: SessionRecord[];
    worktreeProjects?: Record<string, ProjectRecord>;
}

/**
 * The global Pinned group, above every Project. A pinned Session stays listed under its own Project as well: this group
 * is a second view of the same Sessions rather than a folder they move into, so unpinning never has to put anything
 * back and a user scanning their Projects still finds every Session where they left it.
 *
 * The heading is a `treeitem` at level 1 like a Project heading (it is a collapsible group the arrow keys walk) but it
 * carries no drag source and no Session count menu, because it owns nothing: its membership is a per-Session property,
 * not a list this group holds.
 */
export function PinnedSessionGroup({
    animate,
    expanded,
    focusRenameInput,
    hiddenSessionCount,
    nextRevealCount,
    onBeginRename,
    onBlurRename,
    onCancelRename,
    onCommitRename,
    onSuggestRename,
    onRenameValueChange,
    onRevealMoreSessions,
    onToggle,
    projects,
    renameError,
    renameSuggestingSessionId,
    renameValue,
    renamingRowId,
    rovingRowId,
    selectedSessionId,
    sessionOrder,
    sessions,
    terminals,
    visibleSessions,
    worktreeProjects,
}: PinnedSessionGroupProperties) {
    const visibleSessionIds = useVisibleSessionIds(visibleSessions);
    if (sessions.length === 0) return null;
    const revealRowId = primarySidebarRevealRowId(PINNED_GROUP_ROW_ID);
    return (
        <section className="pinned-session-group relative mb-2" data-pinned-group="">
            <div className="pinned-heading group/pinned-heading flex min-h-7 items-center gap-1 rounded-md text-foreground hover:bg-[color-mix(in_srgb,var(--elevated)_60%,transparent)]">
                <Tooltip content={`${expanded ? 'Collapse' : 'Expand'} Pinned`}>
                    <button
                        className="pinned-disclosure grid h-7 w-4 flex-none cursor-pointer place-items-center border-0 bg-transparent p-0 text-muted hover:text-foreground"
                        aria-controls={PINNED_DISCLOSURE_ID}
                        aria-expanded={expanded}
                        aria-label={`${expanded ? 'Collapse' : 'Expand'} Pinned`}
                        tabIndex={-1}
                        onClick={(event) => {
                            onToggle();
                            focusDisclosureRow(event.currentTarget);
                        }}
                    >
                        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    </button>
                </Tooltip>
                <button
                    className="pinned-select flex min-h-7 min-w-0 flex-1 cursor-pointer items-center gap-1.5 border-0 bg-transparent px-1 text-left text-inherit focus-visible:ring-1 focus-visible:ring-foreground focus-visible:outline-none"
                    role="treeitem"
                    aria-controls={PINNED_DISCLOSURE_ID}
                    aria-expanded={expanded}
                    aria-level={1}
                    aria-selected={false}
                    // The heading shows no digit; the group is short by construction and the rows themselves are the
                    // answer, so the membership reaches assistive technology here instead, where a collapsed group
                    // would otherwise announce nothing about what it holds.
                    aria-label={`Pinned, ${sessions.length} ${sessions.length === 1 ? 'Session' : 'Sessions'}`}
                    data-row-id={PINNED_GROUP_ROW_ID}
                    tabIndex={PINNED_GROUP_ROW_ID === rovingRowId ? 0 : -1}
                    onClick={onToggle}
                >
                    <Pin aria-hidden="true" className="flex-none text-muted" size={13} />
                    <strong className="overflow-fade min-w-0 flex-1 text-[13px] font-medium">
                        Pinned
                    </strong>
                </button>
            </div>
            <DisclosureMotion
                animate={animate}
                className="pinned-session-disclosure"
                expanded={expanded}
                id={PINNED_DISCLOSURE_ID}
                kind="pinned"
            >
                {() => (
                    <div
                        aria-label="Pinned Sessions"
                        className="session-list pb-1 pl-4"
                        role="group"
                    >
                        {visibleSessions.map((session) => {
                            const project = projects[session.id];
                            if (!project) return null;
                            const rowId = primarySidebarPinnedRowId(session.id);
                            return (
                                <MemoizedActiveSessionRow
                                    key={session.id}
                                    focusRenameInput={focusRenameInput}
                                    onBeginRename={onBeginRename}
                                    onBlurRename={onBlurRename}
                                    onCancelRename={onCancelRename}
                                    onCommitRename={onCommitRename}
                                    onSuggestRename={onSuggestRename}
                                    onRenameValueChange={onRenameValueChange}
                                    projectDisplayTitle={project.displayTitle}
                                    projectIcon={project.icon}
                                    projectId={project.id}
                                    projectRootPath={project.rootPath}
                                    renameError={renameError}
                                    renameSuggesting={session.id === renameSuggestingSessionId}
                                    renameValue={renameValue}
                                    renaming={rowId === renamingRowId}
                                    roving={rowId === rovingRowId}
                                    rowId={rowId}
                                    selected={session.id === selectedSessionId}
                                    session={session}
                                    sessionOrder={sessionOrder}
                                    showProjectName
                                    terminal={sessionAgentTerminal(session, terminals)}
                                    visibleSessionIds={visibleSessionIds}
                                    worktreeProject={worktreeProjects?.[session.id]}
                                />
                            );
                        })}
                        {hiddenSessionCount > 0 && (
                            /*
                             * Same reveal row a Project group uses, for the same reason: a long Pinned list would push
                             * every Project off the screen. The button is the row, so it carries the tree semantics. No
                             * disclosure chevron: this is not a collapsible branch.
                             */
                            <button
                                className="session-reveal flex h-7 w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2 text-muted hover:bg-[color-mix(in_srgb,var(--elevated)_60%,transparent)] hover:text-foreground focus-visible:ring-1 focus-visible:ring-foreground focus-visible:outline-none"
                                role="treeitem"
                                aria-label={`Show ${nextRevealCount} more pinned ${nextRevealCount === 1 ? 'Session' : 'Sessions'}`}
                                aria-level={2}
                                aria-selected={false}
                                data-row-id={revealRowId}
                                tabIndex={revealRowId === rovingRowId ? 0 : -1}
                                onClick={onRevealMoreSessions}
                            >
                                Show {nextRevealCount} more
                            </button>
                        )}
                    </div>
                )}
            </DisclosureMotion>
        </section>
    );
}
