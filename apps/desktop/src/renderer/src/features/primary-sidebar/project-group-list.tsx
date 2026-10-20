import type { ProjectRecord, TerminalRecord } from '@caxri/protocol';

import type { useProjectOrder } from './hooks/use-project-order';
import type { ProjectSessionWindow } from './hooks/use-project-session-windows';
import type { SessionOrderController } from './hooks/use-session-order';
import type { SessionRenameController } from './hooks/use-session-rename';
import { ProjectGroup } from './project-group';

interface ProjectGroupListProperties {
    animatedProjectIds: ReadonlySet<string>;
    isProjectExpanded: (projectId: string) => boolean;
    onRevealMoreSessions: (sessionWindow: ProjectSessionWindow) => void;
    onToggleProject: (projectId: string) => void;
    projectOrder: ReturnType<typeof useProjectOrder>;
    /**
     * One windowed Session list per Project, already in sidebar order.
     */
    projectWindows: readonly ProjectSessionWindow[];
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
    onToggleProject,
    projectOrder,
    projectWindows,
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
        const { hiddenCount, nextRevealCount, project, projectSessions, visibleSessions } =
            sessionWindow;
        return (
            <ProjectGroup
                key={project.id}
                active={project.id === selectedProjectId}
                animateProject={animatedProjectIds.has(project.id)}
                dragged={projectOrder.draggedProjectId === project.id}
                expanded={isProjectExpanded(project.id)}
                focusRenameInput={sessionRename.focusRenameInput}
                hiddenSessionCount={hiddenCount}
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
                onMove={(delta) => projectOrder.move(project.id, project.displayTitle, delta)}
                onRenameValueChange={sessionRename.onRenameValueChange}
                onRevealMoreSessions={() => onRevealMoreSessions(sessionWindow)}
                onToggle={() => onToggleProject(project.id)}
                project={project}
                projectSessions={projectSessions}
                projectDropTarget={
                    projectOrder.projectDropTarget?.projectId === project.id
                        ? projectOrder.projectDropTarget
                        : undefined
                }
                renameError={sessionRename.renameError}
                renameSuggestingSessionId={sessionRename.renameSuggestingSessionId}
                renameValue={sessionRename.renameValue}
                renamingRowId={sessionRename.renamingRowId}
                rovingRowId={rovingRowId}
                selectedSessionId={selectedSessionId}
                sessionOrder={sessionOrder}
                showSubagents={showSubagents}
                terminals={terminals}
                visibleSessions={visibleSessions}
                worktreeProjects={worktreeProjects}
            />
        );
    });
}
