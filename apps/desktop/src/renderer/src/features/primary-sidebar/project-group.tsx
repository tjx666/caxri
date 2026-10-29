import type { DragEvent } from 'react';
import { memo, useRef, useState } from 'react';

import type { ProjectRecord, SessionRecord, TerminalRecord } from '@caxri/protocol';
import { ChevronDown, ChevronRight, Paintbrush } from 'lucide-react';

import { executeCommand } from '../../commands/execute';
import { CommandTooltip } from '../../components/command-tooltip';
import { DisclosureMotion } from '../../components/disclosure-motion';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { CreateSessionMenu, EmptyProjectSessionMenu } from '../session/create-session-menu';
import { sessionAgentTerminal } from '../session/session-agent-terminal';
import { ActiveSessionRow } from './active-session-row';
import type { SessionOrderController } from './hooks/use-session-order';
import { useVisibleSessionIds } from './hooks/use-visible-session-ids';
import { focusDisclosureRow } from './primary-sidebar-focus';
import {
    primarySidebarCreateSessionRowId,
    primarySidebarRevealRowId,
} from './primary-sidebar-tree';
import { ProjectAgentSummary } from './project-agent-summary';
import { ProjectDetailsCard } from './project-details-card';
import { describeProjectSessionCount } from './project-heading';
import { ProjectIcon } from './project-icon';
import type { ProjectDropTarget } from './project-order';
import { hasProjectDragType } from './project-order';
import { ProjectRowMenu } from './project-row-menu';
import { SessionRevealRow } from './session-reveal-row';
import { sessionRowActionButton } from './session-row-actions';
import { summarizeSessionStatuses } from './session-status';
import { rovingSubagentRowId } from './session-subagents';

/**
 * Rows render through a memo boundary so a Session switch renders only the rows whose selection moved; the props this
 * list passes are shaped for it, as `ActiveSessionRow` explains (issue #1356).
 */
const MemoizedActiveSessionRow = memo(ActiveSessionRow);

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
    onBeginRename: (sessionId: string, title: string, rowId: string) => void;
    onBlurRename: () => void;
    onCancelRename: () => void;
    onCommitRename: () => void;
    onSuggestRename: (sessionId: string, title: string, rowId: string) => void;
    onDragEnd: () => void;
    onDragOver: (event: DragEvent<HTMLElement>) => void;
    onDragStart: (event: DragEvent<HTMLElement>) => void;
    onDrop: (event: DragEvent<HTMLElement>) => void;
    onMove: (delta: -1 | 1) => void;
    onRenameValueChange: (value: string) => void;
    onRevealMoreSessions: () => void;
    onToggle: () => void;
    project: ProjectRecord;
    /**
     * Every active Session in this Project, including those outside the reveal window.
     */
    projectSessions: readonly SessionRecord[];
    projectDropTarget?: ProjectDropTarget;
    renameError?: string;
    renameSuggestingSessionId?: string;
    renameValue: string;
    renamingRowId?: string;
    /**
     * Id of the row that currently owns the tree's single roving Tab stop.
     */
    rovingRowId?: string;
    selectedSessionId?: string;
    /**
     * Whether Chat Sessions list their subagents under them (`primarySidebar.showSubagents`).
     */
    showSubagents: boolean;
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
    onSuggestRename,
    onDragEnd,
    onDragOver,
    onDragStart,
    onDrop,
    onMove,
    onRenameValueChange,
    onRevealMoreSessions,
    onToggle,
    project,
    projectSessions,
    projectDropTarget,
    renameError,
    renameSuggestingSessionId,
    renameValue,
    renamingRowId,
    rovingRowId,
    selectedSessionId,
    showSubagents,
    terminals,
    visibleSessions,
    worktreeProjects,
}: ProjectGroupProperties) {
    const projectDisclosureId = `project-sessions-${project.id}`;
    const revealRowId = primarySidebarRevealRowId(project.id);
    const createSessionRowId = primarySidebarCreateSessionRowId(project.id);
    const [menuOpen, setMenuOpen] = useState(false);
    const headingReference = useRef<HTMLDivElement>(null);
    const visibleSessionIds = useVisibleSessionIds(visibleSessions);
    const { t } = useTranslation();
    const disclosureLabel = t(
        expanded ? 'primarySidebar.project.collapse' : 'primarySidebar.project.expand',
        {
            title: project.title,
        },
    );
    /**
     * A collapsed Project hides its rows, and with them every running arc and attention ring. Summarize them on the
     * heading so an Agent waiting on the user is never folded out of sight; an expanded Project shows the rows
     * instead.
     */
    const agentSummary = expanded
        ? undefined
        : summarizeSessionStatuses(projectSessions, (s) => sessionAgentTerminal(s, terminals), t);
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
            <ProjectRowMenu project={project} onOpenChange={setMenuOpen}>
                {/*
                 * The Project drag source and the row's layout. Its tree semantics live on the `.project-select`
                 * button below, which is the element that owns the roving Tab stop: `aria-level`, `aria-selected`, and
                 * `aria-expanded` have to sit on the element focus reaches, not on the box around it.
                 */}
                <div
                    ref={headingReference}
                    className="project-heading group/project-heading relative flex min-h-7 cursor-grab items-center gap-1 rounded-md text-foreground [--project-hover-actions:2.875rem] hover:bg-state-hover hover:pr-[var(--project-hover-actions)] active:cursor-grabbing has-focus-visible:pr-[var(--project-hover-actions)] has-[[data-popup-open]]:pr-[var(--project-hover-actions)]"
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
                    <Tooltip content={disclosureLabel}>
                        <button
                            className="project-disclosure grid h-7 w-4 flex-none cursor-pointer place-items-center border-0 bg-transparent p-0 text-muted hover:text-foreground"
                            aria-controls={projectDisclosureId}
                            aria-expanded={expanded}
                            aria-label={disclosureLabel}
                            tabIndex={-1}
                            onClick={(event) => {
                                onToggle();
                                focusDisclosureRow(event.currentTarget);
                            }}
                        >
                            {/*
                             * The disclosure cue is this chevron, never the folder glyph beside it: a Project with a
                             * custom icon keeps that icon in both states, so an open/closed icon swap tells a user who
                             * customized their Projects nothing at all. Same twistie-then-icon order the Source
                             * Control and extension trees already use.
                             */}
                            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                        </button>
                    </Tooltip>
                    <ProjectDetailsCard
                        anchor={headingReference}
                        project={project}
                        sessionCount={projectSessions.length}
                        suppressed={menuOpen}
                        trigger={
                            <button
                                className="project-select flex min-h-7 min-w-0 flex-1 cursor-pointer items-center gap-1.5 border-0 bg-transparent px-1 text-left text-inherit focus-visible:ring-1 focus-visible:ring-foreground focus-visible:outline-none"
                                role="treeitem"
                                aria-controls={projectDisclosureId}
                                aria-expanded={expanded}
                                aria-level={1}
                                aria-selected={active}
                                aria-description={t('primarySidebar.project.actionsHint')}
                                aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Shift+F10"
                                // The count moved into the detail card visually but stays in the treeitem's name so
                                // collapsed Projects remain equally informative to assistive technology.
                                aria-label={describeProjectSessionCount(
                                    project.title,
                                    projectSessions.length,
                                    agentSummary,
                                    t,
                                )}
                                data-row-id={project.id}
                                tabIndex={project.id === rovingRowId ? 0 : -1}
                                onClick={onToggle}
                                onKeyDown={(event) => {
                                    if (
                                        event.key === 'ContextMenu' ||
                                        (event.key === 'F10' && event.shiftKey)
                                    ) {
                                        event.preventDefault();
                                        /**
                                         * MacOS Chromium never turns Shift+F10 into a `contextmenu` event, and the
                                         * native menu opens at that event's coordinates, so the keyboard path
                                         * synthesizes one anchored under the heading instead of at the pointer.
                                         */
                                        const heading = headingReference.current;
                                        if (heading) {
                                            const bounds = heading.getBoundingClientRect();
                                            heading.dispatchEvent(
                                                new MouseEvent('contextmenu', {
                                                    bubbles: true,
                                                    cancelable: true,
                                                    button: 2,
                                                    clientX: bounds.left + 16,
                                                    clientY: bounds.bottom,
                                                }),
                                            );
                                        }
                                        return;
                                    }
                                    if (!event.altKey) return;
                                    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                                        event.preventDefault();
                                        onMove(event.key === 'ArrowUp' ? -1 : 1);
                                    }
                                }}
                            >
                                <ProjectIcon
                                    className="flex-none"
                                    expanded={expanded}
                                    icon={project.icon}
                                />
                                <strong className="overflow-fade min-w-0 flex-1 text-[13px] font-medium [--overflow-fade-size:16px]">
                                    {project.title}
                                </strong>
                                {agentSummary && <ProjectAgentSummary summary={agentSummary} />}
                            </button>
                        }
                    />
                    {/*
                     * The hover actions float over the row's trailing edge instead of holding a slot at rest: a
                     * reserved slot for two invisible buttons cost every Project name ~60px at the side bar's usual
                     * width. The heading publishes the cluster's width (`right-1` plus two `size-5` buttons and
                     * `gap-0.5`) as `--project-hover-actions` and pads by it only while the actions show, so the name
                     * fades before them instead of painting under them, the same rule `SessionRowActions` follows. The
                     * buttons reuse the Session chip so both levels of the tree show one size of hover action.
                     * Keyboard focus reveals them through `:focus-visible`, not `:focus-within`: a pointer collapse
                     * leaves focus on the row, and `:focus-within` kept the actions shown after the pointer left.
                     */}
                    <div className="project-heading-actions absolute top-1/2 right-1 z-10 flex -translate-y-1/2 items-center gap-0.5">
                        <CommandTooltip commandId="project.customizeIcon">
                            <button
                                type="button"
                                className={`${sessionRowActionButton} pointer-events-none opacity-0 transition-opacity group-hover/project-heading:pointer-events-auto group-hover/project-heading:opacity-100 group-has-focus-visible/project-heading:pointer-events-auto group-has-focus-visible/project-heading:opacity-100`}
                                aria-label={t('primarySidebar.project.customizeIconAriaLabel', {
                                    title: project.title,
                                })}
                                tabIndex={-1}
                                onClick={() =>
                                    executeCommand('project.customizeIcon', {
                                        projectId: project.id,
                                    })
                                }
                            >
                                <Paintbrush size={12} />
                            </button>
                        </CommandTooltip>
                        <CreateSessionMenu project={project} />
                    </div>
                </div>
            </ProjectRowMenu>
            <div
                aria-hidden="true"
                className="project-drag-preview pointer-events-none fixed -top-[1000px] left-0 flex h-7 items-center gap-2 rounded-md bg-elevated px-2 text-foreground shadow-[0_8px_24px_var(--shadow)]"
            >
                <ProjectIcon icon={project.icon} />
                <span className="max-w-48 truncate text-[13px] font-medium">{project.title}</span>
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
                        aria-label={t('primarySidebar.project.sessionsAriaLabel', {
                            title: project.title,
                        })}
                        className="session-list pb-1 pl-4"
                        role="group"
                    >
                        {visibleSessions.map((session) => (
                            <MemoizedActiveSessionRow
                                sessionOrder={sessionOrder}
                                visibleSessionIds={visibleSessionIds}
                                key={session.id}
                                focusRenameInput={focusRenameInput}
                                onBeginRename={onBeginRename}
                                onBlurRename={onBlurRename}
                                onCancelRename={onCancelRename}
                                onCommitRename={onCommitRename}
                                onSuggestRename={onSuggestRename}
                                onRenameValueChange={onRenameValueChange}
                                projectTitle={project.title}
                                projectIcon={project.icon}
                                projectId={project.id}
                                projectRootPath={project.rootPath}
                                renameError={renameError}
                                renameSuggesting={session.id === renameSuggestingSessionId}
                                renameValue={renameValue}
                                renaming={session.id === renamingRowId}
                                roving={session.id === rovingRowId}
                                selected={session.id === selectedSessionId}
                                session={session}
                                showSubagents={showSubagents}
                                subagentRovingRowId={rovingSubagentRowId(rovingRowId, session.id)}
                                terminal={sessionAgentTerminal(session, terminals)}
                                worktreeProject={worktreeProjects?.[session.id]}
                            />
                        ))}
                        {hiddenSessionCount > 0 && (
                            <SessionRevealRow
                                count={nextRevealCount}
                                projectTitle={project.title}
                                roving={revealRowId === rovingRowId}
                                rowId={revealRowId}
                                onReveal={onRevealMoreSessions}
                            />
                        )}
                        {visibleSessions.length === 0 && (
                            <EmptyProjectSessionMenu
                                project={project}
                                roving={createSessionRowId === rovingRowId}
                                rowId={createSessionRowId}
                            />
                        )}
                    </div>
                )}
            </DisclosureMotion>
        </section>
    );
}
