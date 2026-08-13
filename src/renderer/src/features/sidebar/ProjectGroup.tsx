import { Archive, Circle, FolderClosed, FolderOpen, Plus } from 'lucide-react';
import type { DragEvent } from 'react';

import type { ProjectRecord, SessionRecord, TerminalRecord } from '@shared/types';

import { DisclosureMotion } from '../../components/DisclosureMotion';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { CommandTooltip, Tooltip } from '../../components/ui/tooltip';
import { AgentIdentityIcon } from '../../icons/agents/AgentIdentityIcon';
import { cn } from '../../lib/utils';
import { setArchivedSessionsOpen } from '../../stores/dialogs';
import { requestArchivedSessionsForProject } from '../session/archived-sessions';
import { archiveSession, selectSession } from '../session/session-actions';
import { SessionActivityCard } from './SessionActivityCard';
import {
    sessionActivityPresentation,
    sessionToneBackgroundClassName,
    sessionToneBorderClassName,
} from './session-activity';
import {
    hasProjectDragType,
    resolveProjectHeadingClick,
    type ProjectDropTarget,
} from './project-order';

const sessionCardClassName =
    'session-card flex w-full h-7 items-center gap-2 px-2 border-0 rounded-md bg-transparent text-foreground text-left cursor-pointer hover:bg-[color-mix(in_srgb,var(--elevated)_60%,transparent)]';

/**
 * The ring reuses `sessionActivityPresentation`'s tone (success/warning/danger/neutral) instead of
 * `--accent` — DESIGN.md reserves accent for the single focused pane/tab, and the Sidebar stays
 * entirely neutral otherwise. `lastAttentionKind` is a subset of `AgentActivityState`'s keys, so the
 * same presentation table already used for the activity dot applies unchanged.
 */
function UnreadAttentionIndicator({ session }: { session: SessionRecord }) {
    if (!session.hasUnread) return null;
    const attention = sessionActivityPresentation(session.lastAttentionKind ?? 'unknown');
    const label = `Unread: ${attention.label}`;
    return (
        <span
            role="img"
            aria-label={label}
            className={cn(
                'session-unread flex size-3 flex-none items-center justify-center rounded-full border',
                sessionToneBorderClassName(attention.tone),
            )}
            data-attention-kind={session.lastAttentionKind}
            title={label}
        >
            <span
                className={cn(
                    'size-1.5 rounded-full',
                    sessionToneBackgroundClassName(attention.tone),
                )}
            />
        </span>
    );
}

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

interface ActiveSessionRowProps {
    focusRenameInput: (element: HTMLInputElement | null) => void;
    onBeginRename: () => void;
    onBlurRename: () => void;
    onCancelRename: () => void;
    onCommitRename: () => void;
    onRenameValueChange: (value: string) => void;
    project: ProjectRecord;
    renameError?: string;
    renameValue: string;
    renaming: boolean;
    /** True when this Session row currently owns the tree's single roving Tab stop. */
    roving: boolean;
    selected: boolean;
    session: SessionRecord;
    terminal?: TerminalRecord;
}

function ActiveSessionRow({
    focusRenameInput,
    onBeginRename,
    onBlurRename,
    onCancelRename,
    onCommitRename,
    onRenameValueChange,
    project,
    renameError,
    renameValue,
    renaming,
    roving,
    selected,
    session,
    terminal,
}: ActiveSessionRowProps) {
    const activity = sessionActivityPresentation(session.lastActivityState);
    const renameErrorId = `session-rename-error-${session.id}`;
    const sessionCard = (
        <div
            data-row-id={session.id}
            data-session-id={session.id}
            className={cn(
                sessionCardClassName,
                'pr-8',
                'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground',
                selected && 'active bg-elevated',
                renaming && 'cursor-text',
            )}
            role={renaming ? undefined : 'button'}
            tabIndex={renaming ? undefined : roving ? 0 : -1}
            onClick={() => {
                if (!renaming && !selected) void selectSession(session.id);
            }}
            onDoubleClick={onBeginRename}
            onKeyDown={(event) => {
                if (!renaming && event.key === 'Enter') {
                    event.preventDefault();
                    onBeginRename();
                } else if (!renaming && event.key === ' ') {
                    event.preventDefault();
                    if (!selected) void selectSession(session.id);
                }
            }}
        >
            <span
                role="img"
                aria-label={activity.ariaLabel}
                title={activity.label}
                className={cn(
                    `activity activity-${session.lastActivityState}`,
                    'flex flex-none items-center',
                    activity.indicatorClassName,
                )}
            >
                <Circle size={7} fill="currentColor" />
            </span>
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
                            className="session-rename-error absolute inset-x-0 top-full z-10 mt-0.5 wrap-break-word text-[11px] text-danger"
                        >
                            {renameError}
                        </span>
                    )}
                </>
            ) : (
                <span className="session-copy min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                    {/*
                     * Bolder weight is a non-color, no-hover unread cue: the ring's tone explains
                     * *what* the attention was, but a sighted user should not need to hover the ring
                     * or open the preview card just to notice *that* a row is unread.
                     */}
                    <strong className={session.hasUnread ? 'font-semibold' : 'font-medium'}>
                        {session.displayTitle}
                    </strong>
                </span>
            )}
            <UnreadAttentionIndicator session={session} />
        </div>
    );
    return (
        <div
            aria-level={2}
            aria-selected={selected}
            className="session-row group/session-row relative"
            role="treeitem"
        >
            {renaming ? (
                sessionCard
            ) : (
                <SessionActivityCard
                    project={project}
                    session={session}
                    terminal={terminal}
                    trigger={sessionCard}
                />
            )}
            <Tooltip content="Archive Session">
                <button
                    type="button"
                    className="absolute right-1 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded border-0 bg-elevated p-0 text-muted opacity-0 pointer-events-none cursor-pointer hover:text-foreground group-hover/session-row:opacity-100 group-hover/session-row:pointer-events-auto group-focus-within/session-row:opacity-100 group-focus-within/session-row:pointer-events-auto"
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
}

interface ProjectGroupProps {
    active: boolean;
    activeSessions: SessionRecord[];
    /** Count of this Project's archived Sessions; 0 hides the heading affix entirely. */
    archivedCount: number;
    animateProject: boolean;
    dragged: boolean;
    expanded: boolean;
    focusRenameInput: (element: HTMLInputElement | null) => void;
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
    onSelect: () => void;
    onToggle: () => void;
    project: ProjectRecord;
    projectDropTarget?: ProjectDropTarget;
    renameError?: string;
    renameValue: string;
    renamingSessionId?: string;
    /** Id of the row that currently owns the tree's single roving Tab stop. */
    rovingRowId?: string;
    selectedSessionId?: string;
    terminals: TerminalRecord[];
}

export function ProjectGroup({
    active,
    activeSessions,
    archivedCount,
    animateProject,
    dragged,
    expanded,
    focusRenameInput,
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
    onSelect,
    onToggle,
    project,
    projectDropTarget,
    renameError,
    renameValue,
    renamingSessionId,
    rovingRowId,
    selectedSessionId,
    terminals,
}: ProjectGroupProps) {
    const projectDisclosureId = `project-sessions-${project.id}`;
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
                className="project-heading group/project-heading flex min-h-7 items-center gap-1 rounded-md text-foreground cursor-grab active:cursor-grabbing hover:bg-[color-mix(in_srgb,var(--elevated)_60%,transparent)]"
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
                        className="project-disclosure grid h-7 w-6 flex-none place-items-center border-0 bg-transparent p-0 text-inherit cursor-pointer"
                        aria-controls={projectDisclosureId}
                        aria-expanded={expanded}
                        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${project.displayTitle}`}
                        tabIndex={-1}
                        onClick={onToggle}
                    >
                        {expanded ? (
                            <FolderOpen
                                aria-hidden="true"
                                className="project-folder-icon"
                                size={15}
                                strokeWidth={1.7}
                            />
                        ) : (
                            <FolderClosed
                                aria-hidden="true"
                                className="project-folder-icon"
                                size={15}
                                strokeWidth={1.7}
                            />
                        )}
                    </button>
                </Tooltip>
                <button
                    className="project-select flex min-h-7 min-w-0 flex-1 items-center px-1 text-inherit text-left border-0 bg-transparent cursor-pointer"
                    aria-controls={projectDisclosureId}
                    aria-expanded={expanded}
                    aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                    data-row-id={project.id}
                    tabIndex={project.id === rovingRowId ? 0 : -1}
                    onClick={() => {
                        const effect = resolveProjectHeadingClick(
                            active,
                            expanded,
                            activeSessions.length > 0,
                        );
                        if (effect.select) onSelect();
                        if (effect.toggle) onToggle();
                    }}
                    onKeyDown={(event) => {
                        if (!event.altKey) return;
                        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                            event.preventDefault();
                            onMove(event.key === 'ArrowUp' ? -1 : 1);
                        }
                    }}
                    title={project.rootPath}
                >
                    <strong className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-semibold">
                        {project.displayTitle}
                    </strong>
                </button>
                <CommandTooltip commandId="session.create">
                    <Button
                        className="pointer-events-none opacity-0 transition-opacity group-hover/project-heading:pointer-events-auto group-hover/project-heading:opacity-100 group-focus-within/project-heading:pointer-events-auto group-focus-within/project-heading:opacity-100"
                        size="icon"
                        variant="ghost"
                        aria-label={`New Session in ${project.displayTitle}`}
                        tabIndex={-1}
                        onClick={onCreateSession}
                    >
                        <Plus size={13} />
                    </Button>
                </CommandTooltip>
                {archivedCount > 0 && (
                    <Tooltip
                        content={`${archivedCount} archived ${archivedCount === 1 ? 'Session' : 'Sessions'}`}
                    >
                        <button
                            type="button"
                            className="project-archived-count flex-none rounded-full border-0 bg-elevated px-1.5 text-[10px] tabular-nums text-muted cursor-pointer hover:text-foreground"
                            aria-label={`${archivedCount} archived ${archivedCount === 1 ? 'Session' : 'Sessions'} in ${project.displayTitle}`}
                            tabIndex={-1}
                            onClick={() => {
                                requestArchivedSessionsForProject(project.id);
                                setArchivedSessionsOpen(true);
                            }}
                        >
                            {archivedCount}
                        </button>
                    </Tooltip>
                )}
            </div>
            <div
                aria-hidden="true"
                className="project-drag-preview pointer-events-none fixed -top-[1000px] left-0 flex h-7 items-center gap-2 rounded-md bg-elevated px-2 text-foreground shadow-[0_8px_24px_var(--shadow)]"
            >
                <FolderClosed aria-hidden="true" size={15} strokeWidth={1.7} />
                <span className="max-w-48 truncate text-[12px] font-medium">
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
                        {activeSessions.map((session) => (
                            <ActiveSessionRow
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
                                renameError={renameError}
                                renameValue={renameValue}
                                renaming={session.id === renamingSessionId}
                                roving={session.id === rovingRowId}
                                selected={session.id === selectedSessionId}
                                session={session}
                                terminal={sessionTerminal(session, terminals)}
                            />
                        ))}
                        {activeSessions.length === 0 && (
                            <button
                                className="empty-project flex h-7 w-full items-center gap-2 px-2 border-0 rounded-md text-muted bg-transparent cursor-pointer hover:text-foreground hover:bg-[color-mix(in_srgb,var(--elevated)_60%,transparent)]"
                                tabIndex={-1}
                                onClick={onCreateSession}
                            >
                                <Plus size={13} /> New Session
                            </button>
                        )}
                    </div>
                )}
            </DisclosureMotion>
        </section>
    );
}
