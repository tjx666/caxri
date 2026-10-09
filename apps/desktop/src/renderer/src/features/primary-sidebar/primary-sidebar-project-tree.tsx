import { useCallback, useMemo, useRef, useState } from 'react';

import type { ProjectRecord, SessionRecord } from '@caxri/protocol';
import { defaultAppSettings, isPinnedSession } from '@caxri/protocol';
import { Plus } from 'lucide-react';

import { executeCommand } from '../../commands/execute';
import { useScrollEdge } from '../../hooks/use-scroll-edge';
import {
    useProjects,
    useSelectedProject,
    useSelectedSession,
    useSessions,
    useSettings,
    useTerminals,
} from '../../stores/selectors';
import { activeSessionsInSidebarOrder } from '../session/session-activity-order';
import { usePinnedCollapse } from './hooks/use-pinned-collapse';
import { usePinnedSessionGroup } from './hooks/use-pinned-session-group';
import { usePrimarySidebarTree } from './hooks/use-primary-sidebar-tree';
import { useProjectCollapse } from './hooks/use-project-collapse';
import { useProjectOrder } from './hooks/use-project-order';
import type { ProjectSessionWindow } from './hooks/use-project-session-windows';
import { useProjectSessionWindows } from './hooks/use-project-session-windows';
import { useSessionOrder } from './hooks/use-session-order';
import { useSessionPullRequestPoll } from './hooks/use-session-pull-request';
import { useSessionRename } from './hooks/use-session-rename';
import { PinnedSessionGroup } from './pinned-session-group';
import { unpinnedSessions } from './pinned-session-order';
import { PINNED_GROUP_ROW_ID, primarySidebarPinnedRowId } from './primary-sidebar-tree';
import { handlePrimarySidebarTreeKey } from './primary-sidebar-tree-keys';
import { ProjectGroupList } from './project-group-list';
import { hasProjectDragType } from './project-order';
import { sessionWorktreeProject, topLevelProjects } from './project-visibility';
import { SESSION_REVEAL_STEP } from './session-list-window';

const NO_RECORDS: never[] = [];
const onAddProject = (): void => executeCommand('project.create');

/**
 * The Primary Side Bar's default body: every Project the user added, each holding its Sessions in the order they
 * arranged.
 *
 * Split out of `primary-sidebar.tsx` so Activity mode can replace it outright. Every subscription, poll, and derived
 * order this tree needs lives here rather than in the shell, so switching modes unmounts all of it instead of leaving a
 * hidden tree recomputing behind the queue.
 */
export function PrimarySidebarProjectTree() {
    const allProjects = useProjects();
    /**
     * The tree is the only consumer that hides auto-registered worktree Projects. Filtering once here (before order,
     * collapse, activity order, and the Session windows read it) keeps every derived structure agreeing on which rows
     * exist; `allProjects` stays available for resolving a Session's Workbench Root below.
     */
    const loadedProjects = useMemo(
        () => (allProjects ? topLevelProjects(allProjects) : undefined),
        [allProjects],
    );
    const projects = loadedProjects ?? NO_RECORDS;
    const sessions = useSessions() ?? NO_RECORDS;
    const terminals = useTerminals();
    const autoCollapseSetting =
        useSettings()?.['primarySidebar.autoCollapseProjects'] ??
        defaultAppSettings['primarySidebar.autoCollapseProjects'];
    const selectedProjectId = useSelectedProject()?.id;
    const selectedSessionId = useSelectedSession()?.id;
    const projectOrder = useProjectOrder(projects);
    const projectCollapse = useProjectCollapse({
        autoCollapseSetting,
        projects: loadedProjects,
        selectedSessionId,
        sessions,
    });
    const [animatedProjectIds, setAnimatedProjectIds] = useState<Set<string>>(() => new Set());
    // Owns the cadence only; each Session row subscribes to its own slice of the snapshot this keeps fresh.
    useSessionPullRequestPoll();
    const orderedSessions = useMemo(
        () => unpinnedSessions(activeSessionsInSidebarOrder(projects, sessions)),
        [projects, sessions],
    );
    const { controller: sessionOrder, sessions: sidebarSessions } =
        useSessionOrder(orderedSessions);
    /**
     * Workbench Root Projects keyed by Session id, for the Sessions currently working outside their own Project. This
     * is what replaces the hidden top-level worktree entry, so it must resolve against the full Project list.
     */
    const worktreeProjects = useMemo(() => {
        const resolved: Record<string, ProjectRecord> = {};
        for (const session of sidebarSessions) {
            const worktree = sessionWorktreeProject(session, allProjects ?? NO_RECORDS);
            if (worktree) resolved[session.id] = worktree;
        }
        return resolved;
    }, [allProjects, sidebarSessions]);

    const pinnedCollapse = usePinnedCollapse();
    const pinnedGroup = usePinnedSessionGroup({
        projects: allProjects ?? NO_RECORDS,
        selectedSessionId,
        sessions,
    });

    /**
     * Where `session.rename` has to put its editor. A pinned Session is withheld from its Project group, so the Project
     * row this used to target does not exist for one; expanding that Project would reveal nothing and the rename would
     * silently no-op.
     */
    const revealSessionRow = useCallback(
        (session: SessionRecord): string => {
            if (isPinnedSession(session)) {
                pinnedCollapse.expand();
                return primarySidebarPinnedRowId(session.id);
            }
            projectCollapse.expandProject(session.projectId);
            return session.id;
        },
        [pinnedCollapse, projectCollapse],
    );
    const sessionRename = useSessionRename(sessions, revealSessionRow);

    const isProjectExpanded = projectCollapse.isProjectExpanded;

    /**
     * One windowed Session list per Project, in sidebar order. Shared by the flattened tree rows and the rendered
     * groups so arrow-key navigation can never reach a Session the window hides.
     */
    const sessionWindows = useProjectSessionWindows({
        projects,
        selectedSessionId,
        sidebarSessions,
    });
    const projectWindows = sessionWindows.windows;
    const pinnedSessionIds = useMemo(
        () => pinnedGroup.visibleSessions.map((session) => session.id),
        [pinnedGroup.visibleSessions],
    );
    const treeReference = useRef<HTMLDivElement>(null);
    const projectListReference = useRef<HTMLDivElement>(null);
    useScrollEdge(projectListReference);
    const {
        focusRow,
        handleTreeFocus,
        isGroupExpanded,
        rovingRowId,
        rows: treeRows,
    } = usePrimarySidebarTree({
        hasHiddenPinnedSessions: pinnedGroup.hiddenCount > 0,
        isPinnedExpanded: pinnedCollapse.expanded,
        isProjectExpanded,
        pinnedSessionIds,
        projectWindows,
        selectedProjectId,
        selectedSessionId,
        treeReference,
    });

    const togglePinnedGroup = (): void => {
        setAnimatedProjectIds((current) => new Set(current).add(PINNED_GROUP_ROW_ID));
        pinnedCollapse.toggle();
    };

    const toggleProject = (projectId: string): void => {
        // The Pinned heading is a Project row to the tree's key handling but has no Project behind it, so the one key
        // path that resolves a heading to a toggle is redirected here rather than into the Project collapse record.
        if (projectId === PINNED_GROUP_ROW_ID) {
            togglePinnedGroup();
            return;
        }
        setAnimatedProjectIds((current) => new Set(current).add(projectId));
        projectCollapse.toggleProject(projectId);
    };

    /**
     * The final reveal unmounts the reveal row itself, which would drop the tree's roving Tab stop onto the document
     * body. Both groups hand focus to the row directly above while it still exists.
     */
    const revealMorePinnedSessions = (): void => {
        pinnedGroup.revealMore();
        const lastVisibleSessionId = pinnedGroup.visibleSessions.at(-1)?.id;
        if (lastVisibleSessionId && pinnedGroup.hiddenCount <= SESSION_REVEAL_STEP)
            focusRow(primarySidebarPinnedRowId(lastVisibleSessionId));
    };

    const revealMoreSessions = (sessionWindow: ProjectSessionWindow): void => {
        sessionWindows.revealMore(sessionWindow.project.id, sessionWindow.windowCount);
        // The final step unmounts the reveal row itself, which would drop the tree's roving Tab stop onto the document
        // body. Hand focus to the Session row directly above it while that row still exists: the same pre-unmount
        // handoff the Delete/Backspace archive path performs.
        const lastVisibleSessionId = sessionWindow.visibleSessions.at(-1)?.id;
        if (lastVisibleSessionId && sessionWindow.hiddenCount <= SESSION_REVEAL_STEP)
            focusRow(lastVisibleSessionId);
    };

    return (
        <div className="scroll-edge-shell relative min-h-0 flex-1">
            <div
                ref={projectListReference}
                className="project-list absolute inset-0 overflow-auto p-2"
                data-scrolled="false"
                onDragOver={(event) => {
                    if (
                        !(event.target instanceof Element) ||
                        !event.target.closest('.session-card')
                    ) {
                        // Both lists, or the group the drag did not start in keeps its marker on screen until dragend.
                        sessionOrder.leaveList();
                        pinnedGroup.sessionOrder.leaveList();
                    }
                    if (!hasProjectDragType(event.dataTransfer.types)) return;
                    projectOrder.onListDragOver(event);
                }}
                onBlurCapture={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget))
                        projectCollapse.setHasFocus(false);
                }}
                onFocus={() => projectCollapse.setHasFocus(true)}
                onPointerEnter={() => projectCollapse.setIsHovered(true)}
                onPointerLeave={() => projectCollapse.setIsHovered(false)}
            >
                {/*
                 * The tree element holds Project and Session rows and nothing else. The empty-state action and the two
                 * live regions below sit outside it on purpose: inside a `role="tree"`, every focusable element has to
                 * be a real `treeitem` holding the tree's single roving Tab stop (DESIGN.md), and a static region is
                 * not a tree row at all. The scroll container, the Project drop target, and the hover/focus tracking
                 * stay on the wrapper so none of that changes with it.
                 */}
                <div
                    ref={treeReference}
                    aria-label="Primary Side Bar"
                    role="tree"
                    /*
                     * Not a Tab stop (rows own the only one) but `focusChromeSurface` falls back to the tree itself
                     * while it holds no rows, and `.focus()` on an element without a `tabIndex` does nothing at all. A
                     * Project-less workbench would otherwise answer `Cmd+0` by revealing the side bar and leaving the
                     * keyboard in the Terminal, with the empty state's Add Project button still out of reach.
                     */
                    tabIndex={-1}
                    onFocusCapture={handleTreeFocus}
                    onKeyDown={(event) =>
                        handlePrimarySidebarTreeKey(event, {
                            focusRow,
                            isProjectExpanded: isGroupExpanded,
                            rows: treeRows,
                            toggleProject,
                        })
                    }
                >
                    <PinnedSessionGroup
                        animate={animatedProjectIds.has(PINNED_GROUP_ROW_ID)}
                        expanded={pinnedCollapse.expanded}
                        focusRenameInput={sessionRename.focusRenameInput}
                        hiddenSessionCount={pinnedGroup.hiddenCount}
                        nextRevealCount={pinnedGroup.nextRevealCount}
                        onBeginRename={sessionRename.beginRename}
                        onBlurRename={sessionRename.blurRename}
                        onCancelRename={sessionRename.cancelRename}
                        onCommitRename={sessionRename.commitRename}
                        onSuggestRename={sessionRename.suggestRename}
                        onRenameValueChange={sessionRename.onRenameValueChange}
                        onRevealMoreSessions={revealMorePinnedSessions}
                        onToggle={() => togglePinnedGroup()}
                        projects={pinnedGroup.projects}
                        renameError={sessionRename.renameError}
                        renameSuggestingSessionId={sessionRename.renameSuggestingSessionId}
                        renameValue={sessionRename.renameValue}
                        renamingRowId={sessionRename.renamingRowId}
                        rovingRowId={rovingRowId}
                        selectedSessionId={selectedSessionId}
                        sessionOrder={pinnedGroup.sessionOrder}
                        sessions={pinnedGroup.sessions}
                        terminals={terminals}
                        visibleSessions={pinnedGroup.visibleSessions}
                        worktreeProjects={pinnedGroup.worktreeProjects}
                    />
                    <ProjectGroupList
                        animatedProjectIds={animatedProjectIds}
                        isProjectExpanded={isProjectExpanded}
                        onRevealMoreSessions={revealMoreSessions}
                        onToggleProject={toggleProject}
                        projectOrder={projectOrder}
                        projectWindows={projectWindows}
                        rovingRowId={rovingRowId}
                        selectedProjectId={selectedProjectId}
                        selectedSessionId={selectedSessionId}
                        sessionOrder={sessionOrder}
                        sessionRename={sessionRename}
                        terminals={terminals}
                        worktreeProjects={worktreeProjects}
                    />
                </div>
                {projects.length === 0 && (
                    <button
                        className="first-session flex min-h-[72px] w-full cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-border bg-transparent p-4 text-muted hover:border-muted hover:text-foreground"
                        onClick={onAddProject}
                    >
                        <Plus size={16} /> Add your first Project
                    </button>
                )}
                <div className="project-order-announcement sr-only" aria-live="polite">
                    {projectOrder.projectOrderAnnouncement}
                </div>
                <div className="session-order-announcement sr-only" aria-live="polite">
                    {sessionOrder.announcement}
                </div>
                {/*
                 * The Pinned group reorders through its own controller, so it needs its own live region: one shared
                 * region would have to pick a winner whenever both held text, and an `aria-live` node that keeps
                 * swapping owners re-announces the losing message.
                 */}
                <div className="pinned-order-announcement sr-only" aria-live="polite">
                    {pinnedGroup.sessionOrder.announcement}
                </div>
            </div>
        </div>
    );
}
