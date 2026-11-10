import type { ProjectRecord, TerminalRecord } from '@caxri/protocol';

import type { RenderDelegatedRows } from './delegated/delegated-session-rows';
import type { useProjectOrder } from './hooks/use-project-order';
import type { ProjectSessionWindow } from './hooks/use-project-session-windows';
import type { SessionOrderController } from './hooks/use-session-order';
import type { SessionRenameController } from './hooks/use-session-rename';
import { ProjectGroup } from './project-group';
import { shouldHeadingHoldSelection } from './project-heading';

interface ProjectGroupListProperties {
    animatedProjectIds: ReadonlySet<string>;
    isProjectExpanded: (projectId: string) => boolean;
    onRevealMoreSessions: (sessionWindow: ProjectSessionWindow) => void;
    onShowFewerSessions: (sessionWindow: ProjectSessionWindow) => void;
    onToggleProject: (projectId: string) => void;
    projectOrder: ReturnType<typeof useProjectOrder>;
    /**
     * One windowed Session list per Project, already in sidebar order.
     */
    projectWindows: readonly ProjectSessionWindow[];
    /**
     * Renders the Sessions nested under a host Session, right after the host's row.
     */
    renderDelegatedRows: RenderDelegatedRows;
    rovingRowId?: string;
    selectedProjectId?: string;
    selectedSessionId?: string;
    sessionOrder: SessionOrderController;
    sessionRename: SessionRenameController;
    showSubagents: boolean;
    terminals: TerminalRecord[];
    /**
     * Workbench Root Projects keyed by Session id, for Sessions working outside their own Project.
     */
    worktreeProjects: Record<string, ProjectRecord>;
}

/**
 * The Project half of the sidebar tree. Split out of `PrimarySidebar` so that component stays a wiring layer: this list
 * only forwards one window's worth of props per Project and has no state of its own.
 */
export function ProjectGroupList({
    animatedProjectIds,
    isProjectExpanded,
    onRevealMoreSessions,
    onShowFewerSessions,
    onToggleProject,
    projectOrder,
    projectWindows,
    renderDelegatedRows,
    rovingRowId,
    selectedProjectId,
    selectedSessionId,
    sessionOrder,
    sessionRename,
    showSubagents,
    terminals,
    worktreeProjects,
}: ProjectGroupListProperties) {
    return projectWindows.map((sessionWindow) => {
        const {
            hiddenCount,
            members,
            nextRevealCount,
            project,
            projectSessions,
            showFewerIndex,
            statusSessions,
            visibleSessions,
        } = sessionWindow;
        return (
            <ProjectGroup
                key={project.id}
                active={project.id === selectedProjectId}
                animateProject={animatedProjectIds.has(project.id)}
                dragged={projectOrder.draggedProjectId === project.id}
                expanded={isProjectExpanded(project.id)}
                holdsSelection={shouldHeadingHoldSelection(
                    isProjectExpanded(project.id),
                    statusSessions,
                    selectedSessionId,
                )}
                focusRenameInput={sessionRename.focusRenameInput}
                hiddenSessionCount={hiddenCount}
                members={members}
                nextRevealCount={nextRevealCount}
                onBeginRename={sessionRename.beginRename}
                onBlurRename={sessionRename.blurRename}
                onCancelRename={sessionRename.cancelRename}
                onCommitRename={sessionRename.commitRename}
                onSuggestRename={sessionRename.suggestRename}
                onDragEnd={projectOrder.endDrag}
                onDragOver={(event) => projectOrder.updateDropTarget(event, project.id)}
                onDragStart={(event) => projectOrder.startDrag(event, project.id)}
                onDrop={(event) => projectOrder.drop(event, project.id)}
                onMove={(delta) => projectOrder.move(project.id, project.title, delta)}
                onRenameValueChange={sessionRename.onRenameValueChange}
                onRevealMoreSessions={() => onRevealMoreSessions(sessionWindow)}
                onShowFewerSessions={() => onShowFewerSessions(sessionWindow)}
                onToggle={() => onToggleProject(project.id)}
                project={project}
                projectSessions={projectSessions}
                showFewerIndex={showFewerIndex}
                projectDropTarget={
                    projectOrder.projectDropTarget?.projectId === project.id
                        ? projectOrder.projectDropTarget
                        : undefined
                }
                renderDelegatedRows={renderDelegatedRows}
                renameError={sessionRename.renameError}
                renameSuggestingSessionId={sessionRename.renameSuggestingSessionId}
                renameValue={sessionRename.renameValue}
                renamingRowId={sessionRename.renamingRowId}
                rovingRowId={rovingRowId}
                selectedSessionId={selectedSessionId}
                sessionOrder={sessionOrder}
                showSubagents={showSubagents}
                statusSessions={statusSessions}
                terminals={terminals}
                visibleSessions={visibleSessions}
                worktreeProjects={worktreeProjects}
            />
        );
    });
}
