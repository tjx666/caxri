import {
    Archive,
    ArchiveRestore,
    ChevronDown,
    ChevronRight,
    Circle,
    FolderClosed,
    FolderOpen,
    Plus,
    Trash2,
} from 'lucide-react';
import type { DragEvent } from 'react';

import type {
    AgentActivityState,
    ProjectRecord,
    SessionRecord,
    TerminalRecord,
} from '@shared/types';

import { DisclosureMotion } from '../../components/DisclosureMotion';
import { Button } from '../../components/ui/button';
import { CommandTooltip, Tooltip } from '../../components/ui/tooltip';
import { AgentIdentityIcon } from '../../icons/agents/AgentIdentityIcon';
import { cn } from '../../lib/utils';
import {
    archiveSession,
    deleteSession,
    selectSession,
    unarchiveSession,
} from '../session/session-actions';
import {
    hasProjectDragType,
    resolveProjectHeadingClick,
    type ProjectDropTarget,
} from './project-order';

/** Every activity color needs a text twin, so the dot carries the same wording as a tooltip. */
const ACTIVITY_LABELS: Record<AgentActivityState, string> = {
    completed: 'Finished',
    failed: 'Failed',
    idle: 'Idle',
    running: 'Working',
    unknown: 'No activity reported',
    waiting: 'Waiting for you',
};

const sessionCardClassName =
    'session-card flex w-full h-7 items-center gap-2 px-2 border-0 rounded-md bg-transparent text-foreground text-left cursor-pointer hover:bg-[color-mix(in_srgb,var(--elevated)_60%,transparent)]';

const ATTENTION_LABELS = {
    completed: 'Finished',
    failed: 'Failed',
    waiting: 'Waiting for you',
} as const;

function UnreadAttentionIndicator({ session }: { session: SessionRecord }) {
    if (!session.hasUnread) return null;
    const detail = session.lastAttentionKind
        ? ATTENTION_LABELS[session.lastAttentionKind]
        : 'Agent attention';
    const label = `Unread: ${detail}`;
    return (
        <span
            role="img"
            aria-label={label}
            className="session-unread flex size-3 flex-none items-center justify-center rounded-full border border-accent"
            data-attention-kind={session.lastAttentionKind}
            title={label}
        >
            <span className="size-1.5 rounded-full bg-accent" />
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
    renameError?: string;
    renameValue: string;
    renaming: boolean;
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
    renameError,
    renameValue,
    renaming,
    selected,
    session,
    terminal,
}: ActiveSessionRowProps) {
    const activityLabel = ACTIVITY_LABELS[session.lastActivityState];
    const renameErrorId = `session-rename-error-${session.id}`;
    return (
        <div className="session-row group/session-row relative">
            <div
                data-session-id={session.id}
                className={cn(
                    sessionCardClassName,
                    'pr-8',
                    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground',
                    selected && 'active bg-elevated',
                    renaming && 'cursor-text',
                )}
                role={renaming ? undefined : 'button'}
                tabIndex={renaming ? undefined : 0}
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
                    aria-label={activityLabel}
                    title={activityLabel}
                    className={cn(
                        `activity activity-${session.lastActivityState}`,
                        'flex flex-none items-center text-muted',
                        session.lastActivityState === 'running' && 'text-success',
                        session.lastActivityState === 'waiting' && 'text-warning',
                        session.lastActivityState === 'failed' && 'text-danger',
                    )}
                >
                    <Circle size={7} fill="currentColor" />
                </span>
                <AgentIdentityIcon identity={terminal?.kind ?? 'shell'} size={14} />
                {renaming ? (
                    <>
                        <input
                            ref={focusRenameInput}
                            className={cn(
                                'session-rename min-w-0 flex-1 rounded border border-border bg-background px-1 text-foreground outline-none focus:border-accent',
                                renameError && 'border-danger focus:border-danger',
                            )}
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
                        />
                        {renameError && (
                            <span
                                id={renameErrorId}
                                role="alert"
                                className="session-rename-error absolute top-full left-0 z-10 mt-0.5 whitespace-nowrap text-[11px] text-danger"
                            >
                                {renameError}
                            </span>
                        )}
                    </>
                ) : (
                    <span className="session-copy min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                        <strong className="font-medium">{session.displayTitle}</strong>
                    </span>
                )}
                <UnreadAttentionIndicator session={session} />
            </div>
            <Tooltip content="Archive Session">
                <button
                    type="button"
                    className="absolute right-1 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded border-0 bg-elevated p-0 text-muted opacity-0 pointer-events-none cursor-pointer hover:text-foreground group-hover/session-row:opacity-100 group-hover/session-row:pointer-events-auto group-focus-within/session-row:opacity-100 group-focus-within/session-row:pointer-events-auto"
                    aria-label={`Archive ${session.displayTitle}`}
                    onClick={() => archiveSession(session.id)}
                >
                    <Archive size={12} />
                </button>
            </Tooltip>
        </div>
    );
}

interface ArchivedSessionsProps {
    animate: boolean;
    expanded: boolean;
    onToggle: () => void;
    sessions: SessionRecord[];
    terminals: TerminalRecord[];
}

function ArchivedSessions({
    animate,
    expanded,
    onToggle,
    sessions,
    terminals,
}: ArchivedSessionsProps) {
    return (
        <div className="archived-sessions mt-1">
            <button
                type="button"
                className="archived-sessions-toggle flex h-7 w-full items-center gap-1.5 rounded-md border-0 bg-transparent px-2 text-left text-[11px] text-muted cursor-pointer hover:bg-[color-mix(in_srgb,var(--elevated)_60%,transparent)] hover:text-foreground"
                aria-expanded={expanded}
                onClick={onToggle}
            >
                {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <Archive size={12} />
                <span className="flex-1">Archived</span>
                <span>{sessions.length}</span>
            </button>
            <DisclosureMotion animate={animate} expanded={expanded} kind="archive">
                {() =>
                    sessions.map((session) => (
                        <div key={session.id} className="archived-row group/archived-row relative">
                            <Tooltip content="Restore Session">
                                <button
                                    type="button"
                                    className="archived-session flex h-7 w-full items-center gap-2 rounded-md border-0 bg-transparent px-2 pr-8 text-left text-muted cursor-pointer hover:bg-[color-mix(in_srgb,var(--elevated)_60%,transparent)] hover:text-foreground"
                                    aria-label={`Restore ${session.displayTitle}`}
                                    onClick={() => unarchiveSession(session.id)}
                                >
                                    <ArchiveRestore size={12} />
                                    <AgentIdentityIcon
                                        identity={
                                            sessionTerminal(session, terminals)?.kind ?? 'shell'
                                        }
                                        size={13}
                                    />
                                    <span className="min-w-0 flex-1 truncate">
                                        {session.displayTitle}
                                    </span>
                                    <UnreadAttentionIndicator session={session} />
                                </button>
                            </Tooltip>
                            <Tooltip content="Delete Session">
                                <button
                                    type="button"
                                    className="absolute right-1 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded border-0 bg-elevated p-0 text-muted opacity-0 pointer-events-none cursor-pointer hover:text-foreground group-hover/archived-row:opacity-100 group-hover/archived-row:pointer-events-auto group-focus-within/archived-row:opacity-100 group-focus-within/archived-row:pointer-events-auto"
                                    aria-label={`Delete ${session.displayTitle}`}
                                    onClick={() => deleteSession(session.id)}
                                >
                                    <Trash2 size={12} />
                                </button>
                            </Tooltip>
                        </div>
                    ))
                }
            </DisclosureMotion>
        </div>
    );
}

interface ProjectGroupProps {
    active: boolean;
    activeSessions: SessionRecord[];
    animateArchive: boolean;
    animateProject: boolean;
    archiveExpanded: boolean;
    archivedSessions: SessionRecord[];
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
    onToggleArchive: () => void;
    project: ProjectRecord;
    projectDropTarget?: ProjectDropTarget;
    renameError?: string;
    renameValue: string;
    renamingSessionId?: string;
    selectedSessionId?: string;
    terminals: TerminalRecord[];
}

export function ProjectGroup({
    active,
    activeSessions,
    animateArchive,
    animateProject,
    archiveExpanded,
    archivedSessions,
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
    onToggleArchive,
    project,
    projectDropTarget,
    renameError,
    renameValue,
    renamingSessionId,
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
                className="project-heading group/project-heading flex min-h-7 items-center gap-1 rounded-md text-foreground cursor-grab active:cursor-grabbing hover:bg-[color-mix(in_srgb,var(--elevated)_60%,transparent)]"
                data-project-id={project.id}
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
                    aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                    onClick={() => {
                        const effect = resolveProjectHeadingClick(active, expanded);
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
                        onClick={onCreateSession}
                    >
                        <Plus size={13} />
                    </Button>
                </CommandTooltip>
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
                    <div className="session-list pb-1 pl-4">
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
                                renameError={renameError}
                                renameValue={renameValue}
                                renaming={session.id === renamingSessionId}
                                selected={session.id === selectedSessionId}
                                session={session}
                                terminal={sessionTerminal(session, terminals)}
                            />
                        ))}
                        {activeSessions.length === 0 && (
                            <button
                                className="empty-project flex h-7 w-full items-center gap-2 px-2 border-0 rounded-md text-muted bg-transparent cursor-pointer hover:text-foreground hover:bg-[color-mix(in_srgb,var(--elevated)_60%,transparent)]"
                                onClick={onCreateSession}
                            >
                                <Plus size={13} /> New Session
                            </button>
                        )}
                        {archivedSessions.length > 0 && (
                            <ArchivedSessions
                                animate={animateArchive}
                                expanded={archiveExpanded}
                                onToggle={onToggleArchive}
                                sessions={archivedSessions}
                                terminals={terminals}
                            />
                        )}
                    </div>
                )}
            </DisclosureMotion>
        </section>
    );
}
