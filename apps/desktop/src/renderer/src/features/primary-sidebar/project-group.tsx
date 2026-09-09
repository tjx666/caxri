import type { DragEvent } from 'react';
import { useState } from 'react';

import type {
    ProjectRecord,
    SessionPullRequest,
    SessionRecord,
    TerminalRecord,
} from '@caxri/protocol';
import { Archive, ChevronDown, FolderGit2, Paintbrush, SquarePen } from 'lucide-react';

import { executeCommand } from '../../commands/execute';
import { CommandTooltip } from '../../components/command-tooltip';
import { DisclosureMotion } from '../../components/disclosure-motion';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Tooltip } from '../../components/ui/tooltip';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { cn } from '../../lib/utilities';
import { archiveSession, didSelectSession } from '../session/session-actions';
import type { SessionOrderController } from './hooks/use-session-order';
import { useSessionTitleScroll } from './hooks/use-session-title-scroll';
import { primarySidebarRevealRowId } from './primary-sidebar-tree';
import { ProjectIcon } from './project-icon';
import type { ProjectDropTarget } from './project-order';
import { hasProjectDragType } from './project-order';
import { SessionActivityCard } from './session-activity-card';
import { SessionPullRequestIndicator } from './session-pull-request-indicator';
import { SessionRowMenu } from './session-row-menu';
import { SessionStatusIndicator } from './session-status-indicator';

const sessionCardClassName =
    'session-card flex w-full h-7 items-center gap-2 px-2 border-0 rounded-md bg-transparent text-foreground text-left cursor-pointer hover:bg-[color-mix(in_srgb,var(--elevated)_60%,transparent)]';

function sessionTerminal(
    session: SessionRecord,
    terminals: TerminalRecord[],
): TerminalRecord | undefined {
    const sessionTerminals = terminals.filter((item) => item.sessionId === session.id);
    return (
        sessionTerminals.find((item) => item.id === session.primaryAgentTerminalId) ??
        sessionTerminals[0]
    );
}

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
    pullRequest?: SessionPullRequest;
    renameError?: string;
    renameValue: string;
    renaming: boolean;
    /**
     * True when this Session row currently owns the tree's single roving Tab stop.
     */
    roving: boolean;
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

function ActiveSessionRow({
    sessionOrder,
    visibleSessions,
    focusRenameInput,
    onBeginRename,
    onBlurRename,
    onCancelRename,
    onCommitRename,
    onRenameValueChange,
    project,
    pullRequest,
    renameError,
    renameValue,
    renaming,
    roving,
    selected,
    session,
    terminal,
    terminals,
    worktreeProject,
}: ActiveSessionRowProperties) {
    const renameErrorId = `session-rename-error-${session.id}`;
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
        <div
            data-row-id={session.id}
            data-session-id={session.id}
            draggable={!renaming}
            onDragStart={(event) => sessionOrder.startDrag(event, session.id)}
            onDragEnd={() => sessionOrder.endDrag()}
            onDragOver={(event) => sessionOrder.dragOver(event, session.id)}
            onDrop={(event) => sessionOrder.drop(event, session.id)}
            className={cn(
                sessionCardClassName,
                'focus-visible:ring-1 focus-visible:ring-foreground focus-visible:outline-none',
                selected && 'active bg-elevated',
                renaming && 'cursor-text',
                sessionOrder.draggedId === session.id && 'opacity-50',
            )}
            role={renaming ? undefined : 'button'}
            aria-keyshortcuts={renaming ? undefined : 'Alt+ArrowUp Alt+ArrowDown'}
            tabIndex={renaming ? undefined : roving ? 0 : -1}
            onFocus={(event) => setFocused(event.currentTarget.matches(':focus-visible'))}
            onBlur={() => setFocused(false)}
            onClick={() => {
                // Fire-and-forget: `didSelectSession` funnels its own failures into a toast.
                // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
                if (!renaming && !selected) void didSelectSession(session.id);
            }}
            onDoubleClick={onBeginRename}
            onKeyDown={(event) => {
                if (!renaming) sessionOrder.keyDown(event, session, visibleSessions);
                if (event.defaultPrevented) return;
                if (!renaming && event.key === 'Enter') {
                    event.preventDefault();
                    onBeginRename();
                } else if (!renaming && event.key === ' ') {
                    event.preventDefault();
                    // Fire-and-forget: `didSelectSession` funnels its own failures into a toast.
                    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
                    if (!selected) void didSelectSession(session.id);
                }
            }}
        >
            <AgentIdentityIcon identity={terminal?.kind ?? 'shell'} size={14} />
            {renaming ? (
                <>
                    <Input
                        ref={focusRenameInput}
                        appearance="workbench"
                        className="session-rename flex-1 text-foreground"
                        aria-label={`Rename ${session.displayTitle}`}
                        aria-invalid={Boolean(renameError)}
                        aria-describedby={renameError ? renameErrorId : undefined}
                        value={renameValue}
                        onBlur={onBlurRename}
                        onChange={(event) => onRenameValueChange(event.target.value)}
                        onClick={(event) => event.stopPropagation()}
                        onDoubleClick={(event) => event.stopPropagation()}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                                event.preventDefault();
                                onCommitRename();
                            } else if (event.key === 'Escape') {
                                event.preventDefault();
                                onCancelRename();
                            }
                        }}
                        size="compact"
                    />
                    {renameError && (
                        <span
                            id={renameErrorId}
                            role="alert"
                            className="session-rename-error absolute inset-x-0 top-full z-10 mt-0.5 text-[11px] wrap-break-word text-danger"
                        >
                            {renameError}
                        </span>
                    )}
                </>
            ) : (
                <span className="session-copy flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
                    <strong
                        ref={viewportReference}
                        className="session-title min-w-0 overflow-hidden font-medium text-ellipsis whitespace-nowrap"
                        onPointerEnter={() => setHovered(true)}
                        onPointerLeave={() => setHovered(false)}
                    >
                        <span ref={textReference} className="block w-max max-w-full truncate">
                            {session.displayTitle}
                        </span>
                    </strong>
                    {worktreeProject && (
                        /*
                         * Deliberately outside the fixed-width `.session-indicators` track, which is sized for exactly
                         * one status glyph. This marker is what replaces the worktree's hidden
                         * top-level sidebar entry, so it belongs with the title it qualifies.
                         *
                         * Decorative on purpose: the row already opens the Session hover card, which names the
                         * worktree, and its accessible description carries the same sentence. A second hover popup on
                         * one row would compete with that card.
                         */
                        <span
                            className="session-worktree flex size-3.5 flex-none items-center justify-center text-muted"
                            data-session-worktree={worktreeProject.displayTitle}
                        >
                            <FolderGit2 aria-hidden="true" size={12} />
                        </span>
                    )}
                </span>
            )}
            {/*
             * One fixed-width slot keeps every Session's glyph aligned. Lifecycle signals take priority over the PR;
             * the PR remains available from the hover card and menu while its row glyph is temporarily hidden.
             */}
            <span className="session-indicators flex w-3.5 flex-none items-center justify-end">
                <SessionStatusIndicator
                    className="transition-opacity group-hover/session-row:opacity-0"
                    fallback={
                        !renaming && (
                            <SessionPullRequestIndicator
                                className="transition-opacity group-hover/session-row:opacity-0"
                                pullRequest={pullRequest}
                            />
                        )
                    }
                    session={session}
                    terminal={terminal}
                />
            </span>
        </div>
    );
    const row = (
        <div
            aria-level={2}
            aria-selected={selected}
            className="session-row group/session-row relative"
            role="treeitem"
        >
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
                    project={project}
                    pullRequest={pullRequest}
                    session={session}
                    suppressed={menuOpen || sessionOrder.draggedId !== undefined}
                    terminal={terminal}
                    trigger={sessionCard}
                    worktreeProject={worktreeProject}
                />
            )}
            <Tooltip content="Archive Session">
                <button
                    type="button"
                    className="pointer-events-none absolute top-1/2 right-1 grid size-5 -translate-y-1/2 cursor-pointer place-items-center rounded border-0 bg-elevated p-0 text-muted opacity-0 transition-opacity group-hover/session-row:pointer-events-auto group-hover/session-row:opacity-100 hover:text-foreground"
                    aria-label={`Archive ${session.displayTitle}`}
                    aria-keyshortcuts="Delete"
                    tabIndex={-1}
                    onClick={() => archiveSession(session.id)}
                >
                    <Archive size={12} />
                </button>
            </Tooltip>
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

interface ProjectGroupProperties {
    sessionOrder: SessionOrderController;
    active: boolean;
    animateProject: boolean;
    dragged: boolean;
    expanded: boolean;
    focusRenameInput: (element: HTMLInputElement | null) => void;
    /**
     * Sessions the window currently hides; a positive count renders the reveal row.
     */
    hiddenSessionCount: number;
    /**
     * Sessions the reveal row promises to add, so its label never overstates the final step.
     */
    nextRevealCount: number;
    onBeginRename: (sessionId: string, displayTitle: string) => void;
    onBlurRename: () => void;
    onCancelRename: () => void;
    onCommitRename: () => void;
    onCreateSession: () => void;
    onDragEnd: () => void;
    onDragOver: (event: DragEvent<HTMLElement>) => void;
    onDragStart: (event: DragEvent<HTMLElement>) => void;
    onDrop: (event: DragEvent<HTMLElement>) => void;
    onMove: (delta: -1 | 1) => void;
    onRenameValueChange: (value: string) => void;
    onRevealMoreSessions: () => void;
    onToggle: () => void;
    project: ProjectRecord;
    projectDropTarget?: ProjectDropTarget;
    /**
     * Discovered pull requests keyed by Session id; absent entries render no glyph.
     */
    pullRequests?: Record<string, SessionPullRequest>;
    renameError?: string;
    renameValue: string;
    renamingSessionId?: string;
    /**
     * Id of the row that currently owns the tree's single roving Tab stop.
     */
    rovingRowId?: string;
    selectedSessionId?: string;
    terminals: TerminalRecord[];
    /**
     * Sessions the window renders, in durable sidebar order (frozen while dragging).
     */
    visibleSessions: SessionRecord[];
    /**
     * Workbench Root Projects keyed by Session id, for Sessions working in a linked worktree; absent entries render no
     * marker. Resolved against the full Project list, which still contains the hidden worktree rows.
     */
    worktreeProjects?: Record<string, ProjectRecord>;
}

export function ProjectGroup({
    sessionOrder,
    active,
    animateProject,
    dragged,
    expanded,
    focusRenameInput,
    hiddenSessionCount,
    nextRevealCount,
    onBeginRename,
    onBlurRename,
    onCancelRename,
    onCommitRename,
    onCreateSession,
    onDragEnd,
    onDragOver,
    onDragStart,
    onDrop,
    onMove,
    onRenameValueChange,
    onRevealMoreSessions,
    onToggle,
    project,
    projectDropTarget,
    pullRequests,
    renameError,
    renameValue,
    renamingSessionId,
    rovingRowId,
    selectedSessionId,
    terminals,
    visibleSessions,
    worktreeProjects,
}: ProjectGroupProperties) {
    const projectDisclosureId = `project-sessions-${project.id}`;
    const revealRowId = primarySidebarRevealRowId(project.id);
    return (
        <section
            data-project-id={project.id}
            className={cn(
                'project-group relative mb-2',
                active && 'active',
                dragged && 'opacity-40',
            )}
        >
            {projectDropTarget && (
                <div
                    className={cn(
                        'project-drop-marker pointer-events-none absolute right-1 left-1 z-10 h-0.5 bg-accent',
                        projectDropTarget.edge === 'before' ? '-top-1' : '-bottom-1',
                    )}
                    data-drop-edge={projectDropTarget.edge}
                >
                    <span className="absolute top-1/2 -left-0.5 size-1.5 -translate-y-1/2 rounded-full bg-accent" />
                </div>
            )}
            <div
                aria-expanded={expanded}
                aria-level={1}
                aria-selected={active}
                className="project-heading group/project-heading flex min-h-7 cursor-grab items-center gap-1 rounded-md text-foreground hover:bg-[color-mix(in_srgb,var(--elevated)_60%,transparent)] active:cursor-grabbing"
                data-project-id={project.id}
                role="treeitem"
                // Programmatically focusable only to satisfy the treeitem-with-drag-handlers
                // a11y contract (react-doctor/interactive-supports-focus); the roving Tab stop
                // stays on the inner `.project-select` button below, not on this wrapper.
                tabIndex={-1}
                draggable
                onDragOver={(event) => {
                    if (!hasProjectDragType(event.dataTransfer.types)) return;
                    onDragOver(event);
                }}
                onDrop={(event) => {
                    if (!hasProjectDragType(event.dataTransfer.types)) return;
                    onDrop(event);
                }}
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
            >
                <Tooltip content={`${expanded ? 'Collapse' : 'Expand'} ${project.displayTitle}`}>
                    <button
                        className="project-disclosure grid h-7 w-6 flex-none cursor-pointer place-items-center border-0 bg-transparent p-0 text-inherit"
                        aria-controls={projectDisclosureId}
                        aria-expanded={expanded}
                        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${project.displayTitle}`}
                        tabIndex={-1}
                        onClick={onToggle}
                    >
                        <ProjectIcon expanded={expanded} icon={project.icon} />
                    </button>
                </Tooltip>
                <button
                    className="project-select flex min-h-7 min-w-0 flex-1 cursor-pointer items-center border-0 bg-transparent px-1 text-left text-inherit"
                    aria-controls={projectDisclosureId}
                    aria-expanded={expanded}
                    aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                    data-row-id={project.id}
                    tabIndex={project.id === rovingRowId ? 0 : -1}
                    onClick={onToggle}
                    onKeyDown={(event) => {
                        if (!event.altKey) return;
                        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                            event.preventDefault();
                            onMove(event.key === 'ArrowUp' ? -1 : 1);
                        }
                    }}
                    title={project.rootPath}
                >
                    <strong className="min-w-0 flex-1 overflow-hidden text-sm font-semibold text-ellipsis whitespace-nowrap">
                        {project.displayTitle}
                    </strong>
                </button>
                <CommandTooltip commandId="project.customizeIcon">
                    <Button
                        className="pointer-events-none opacity-0 transition-opacity group-focus-within/project-heading:pointer-events-auto group-focus-within/project-heading:opacity-100 group-hover/project-heading:pointer-events-auto group-hover/project-heading:opacity-100"
                        size="icon"
                        variant="ghost"
                        aria-label={`Customize Project Icon for ${project.displayTitle}`}
                        tabIndex={-1}
                        onClick={() =>
                            executeCommand('project.customizeIcon', { projectId: project.id })
                        }
                    >
                        <Paintbrush size={13} />
                    </Button>
                </CommandTooltip>
                <CommandTooltip commandId="session.create">
                    <Button
                        className="pointer-events-none opacity-0 transition-opacity group-focus-within/project-heading:pointer-events-auto group-focus-within/project-heading:opacity-100 group-hover/project-heading:pointer-events-auto group-hover/project-heading:opacity-100"
                        size="icon"
                        variant="ghost"
                        aria-label={`New Session in ${project.displayTitle}`}
                        tabIndex={-1}
                        onClick={onCreateSession}
                    >
                        <SquarePen size={13} />
                    </Button>
                </CommandTooltip>
            </div>
            <div
                aria-hidden="true"
                className="project-drag-preview pointer-events-none fixed -top-[1000px] left-0 flex h-7 items-center gap-2 rounded-md bg-elevated px-2 text-foreground shadow-[0_8px_24px_var(--shadow)]"
            >
                <ProjectIcon icon={project.icon} />
                <span className="max-w-48 truncate text-sm font-medium">
                    {project.displayTitle}
                </span>
            </div>
            <DisclosureMotion
                animate={animateProject}
                className="project-session-disclosure"
                expanded={expanded}
                hidden={dragged}
                id={projectDisclosureId}
                kind="project"
            >
                {() => (
                    <div
                        aria-label={`${project.displayTitle} Sessions`}
                        className="session-list pb-1 pl-4"
                        role="group"
                    >
                        {visibleSessions.map((session) => (
                            <ActiveSessionRow
                                sessionOrder={sessionOrder}
                                visibleSessions={visibleSessions}
                                key={session.id}
                                focusRenameInput={focusRenameInput}
                                onBeginRename={() =>
                                    onBeginRename(session.id, session.displayTitle)
                                }
                                onBlurRename={onBlurRename}
                                onCancelRename={onCancelRename}
                                onCommitRename={onCommitRename}
                                onRenameValueChange={onRenameValueChange}
                                project={project}
                                pullRequest={pullRequests?.[session.id]}
                                renameError={renameError}
                                renameValue={renameValue}
                                renaming={session.id === renamingSessionId}
                                roving={session.id === rovingRowId}
                                selected={session.id === selectedSessionId}
                                session={session}
                                terminal={sessionTerminal(session, terminals)}
                                terminals={terminals}
                                worktreeProject={worktreeProjects?.[session.id]}
                            />
                        ))}
                        {hiddenSessionCount > 0 && (
                            <div
                                aria-level={2}
                                aria-selected={false}
                                className="session-reveal-row"
                                role="treeitem"
                            >
                                <button
                                    className="session-reveal flex h-7 w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2 text-muted hover:bg-[color-mix(in_srgb,var(--elevated)_60%,transparent)] hover:text-foreground focus-visible:ring-1 focus-visible:ring-foreground focus-visible:outline-none"
                                    aria-label={`Show ${nextRevealCount} more ${nextRevealCount === 1 ? 'Session' : 'Sessions'} in ${project.displayTitle}`}
                                    data-row-id={revealRowId}
                                    tabIndex={revealRowId === rovingRowId ? 0 : -1}
                                    onClick={onRevealMoreSessions}
                                >
                                    <ChevronDown size={13} /> Show {nextRevealCount} more
                                </button>
                            </div>
                        )}
                        {visibleSessions.length === 0 && (
                            <button
                                className="empty-project flex h-7 w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2 text-muted hover:bg-[color-mix(in_srgb,var(--elevated)_60%,transparent)] hover:text-foreground"
                                tabIndex={-1}
                                onClick={onCreateSession}
                            >
                                <SquarePen size={13} /> New Session
                            </button>
                        )}
                    </div>
                )}
            </DisclosureMotion>
        </section>
    );
}
