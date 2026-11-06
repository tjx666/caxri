import { useCallback, useMemo, useRef, useState } from 'react';

import type { SessionRecord } from '@caxri/protocol';
import { defaultAppSettings, SESSION_REVEAL_STEP } from '@caxri/protocol';

import { useScrollEdge } from '../../hooks/use-scroll-edge';
import { useTranslation } from '../../i18n';
import {
    useProjects,
    useSelectedSession,
    useSessions,
    useSettings,
    useTerminals,
} from '../../stores/selectors';
import { rowSessionsByProject } from './delegated/delegated-order';
import { sessionRevealTarget } from './delegated/delegated-placement';
import { useDelegatedSessionNesting } from './delegated/hooks/use-delegated-session-nesting';
import { useRenderDelegatedRows } from './delegated/hooks/use-render-delegated-rows';
import { usePinnedCollapse } from './hooks/use-pinned-collapse';
import { usePinnedSessionGroup } from './hooks/use-pinned-session-group';
import { usePinnedSessionReveal } from './hooks/use-pinned-session-reveal';
import { usePrimarySidebarTree } from './hooks/use-primary-sidebar-tree';
import { useProjectCollapse } from './hooks/use-project-collapse';
import { useProjectHeadings } from './hooks/use-project-headings';
import { useProjectOrder } from './hooks/use-project-order';
import type { ProjectSessionWindow } from './hooks/use-project-session-windows';
import { useProjectSessionWindows } from './hooks/use-project-session-windows';
import { useSelectedSessionReveal } from './hooks/use-selected-session-reveal';
import { useSessionOrder } from './hooks/use-session-order';
import { useSessionPullRequestPoll } from './hooks/use-session-pull-request';
import { useSessionRename } from './hooks/use-session-rename';
import { useSessionSubagentNodes } from './hooks/use-session-subagent-nodes';
import { PinnedSessionGroup } from './pinned-session-group';
import { unpinnedSessions } from './pinned-session-order';
import { PrimarySidebarLiveRegions } from './primary-sidebar-live-regions';
import { PINNED_GROUP_ROW_ID, primarySidebarPinnedRowId } from './primary-sidebar-tree';
import { handlePrimarySidebarTreeKey } from './primary-sidebar-tree-keys';
import { ProjectGroupList } from './project-group-list';
import { hasProjectDragType, sortByProjectOrder } from './project-order';
import { topLevelProjects, worktreeProjectsBySession } from './project-visibility';
import { SessionSelectionGlideFill } from './session-selection-glide-fill';

const NO_RECORDS: never[] = [];

/**
 * The Primary Side Bar's default body: every Project the user added, each holding its Sessions in the order they
 * arranged.
 *
 * Split out of `primary-sidebar.tsx` so Activity mode can replace it outright. Every subscription, poll, and derived
 * order this tree needs lives here rather than in the shell, so switching modes unmounts all of it instead of leaving a
 * hidden tree recomputing behind the queue.
 */
/**
 * Where `session.rename` has to put its editor. A pinned Session is withheld from its Project group, so the Project row
 * this used to target does not exist for one; expanding that Project would reveal nothing and the rename would silently
 * no-op.
 */
function useRevealSessionRow({
    headingOf,
    pinnedCollapse,
    placement,
    projectCollapse,
}: {
    headingOf: ReadonlyMap<string, string>;
    pinnedCollapse: { expand: () => void };
    placement: Parameters<typeof sessionRevealTarget>[0];
    projectCollapse: { expandProject: (projectId: string) => void };
}): (session: SessionRecord) => string {
    return useCallback(
        (session: SessionRecord): string => {
            // A nested Session opens its host's group, which is not necessarily its own Project.
            const { groupId, rowId } = sessionRevealTarget(placement, session);
            if (groupId === PINNED_GROUP_ROW_ID) pinnedCollapse.expand();
            else projectCollapse.expandProject(headingOf.get(groupId) ?? groupId);
            return rowId;
        },
        [headingOf, pinnedCollapse, placement, projectCollapse],
    );
}

/**
 * Group expand and collapse. A group animates only after the user toggles it, so the ids that did are remembered.
 */
function useGroupToggles(
    pinnedCollapse: { toggle: () => void },
    projectCollapse: { toggleProject: (projectId: string) => void },
) {
    const [animatedProjectIds, setAnimatedProjectIds] = useState<Set<string>>(() => new Set());
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
    return { animatedProjectIds, togglePinnedGroup, toggleProject };
}

export function PrimarySidebarProjectTree() {
    const { t } = useTranslation();
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
    const selectedSessionId = useSelectedSession()?.id;
    /**
     * Where every Session goes: an ordinary row, nested under a host, or hidden. Computed first because the collapse
     * protection, the Session groups, the Pinned group, and the keyboard row order all read it.
     */
    const delegated = useDelegatedSessionNesting({
        projects,
        selectedSessionId,
        sessions,
        terminals,
    });
    const { placement } = delegated;
    const { headingIdBySessionId, headingOf, headingProjects, mergedProjects, selectedProjectId } =
        useProjectHeadings({ placement, projects, sessions });
    const projectOrder = useProjectOrder(headingProjects);
    const projectCollapse = useProjectCollapse({
        autoCollapseSetting,
        groupIdBySessionId: headingIdBySessionId,
        projects: loadedProjects && headingProjects,
        selectedSessionId,
        sessions,
    });
    // Owns the cadence only; each Session row subscribes to its own slice of the snapshot this keeps fresh.
    useSessionPullRequestPoll();
    const orderedSessions = useMemo(
        () => unpinnedSessions(rowSessionsByProject(projects, placement)),
        [projects, placement],
    );
    const { controller: sessionOrder, sessions: sidebarSessions } =
        useSessionOrder(orderedSessions);
    const worktreeProjects = useMemo(
        () => worktreeProjectsBySession(sidebarSessions, allProjects ?? NO_RECORDS),
        [allProjects, sidebarSessions],
    );

    const pinnedCollapse = usePinnedCollapse();
    const pinnedGroup = usePinnedSessionGroup({
        projects: allProjects ?? NO_RECORDS,
        selectedHostSessionId: delegated.selectedHostSessionId,
        selectedSessionId,
        // The Sessions with an ordinary row: a pinned Session that nests (a pinned consult under its creator) is not here.
        sessions: placement.rows,
    });
    const pinAnnouncement = usePinnedSessionReveal({
        expandPinned: pinnedCollapse.expand,
        pinnedSessions: pinnedGroup.sessions,
        revealSession: pinnedGroup.revealSession,
    });

    const revealSessionRow = useRevealSessionRow({
        headingOf,
        pinnedCollapse,
        placement,
        projectCollapse,
    });
    const sessionRename = useSessionRename(sessions, revealSessionRow);
    useSelectedSessionReveal({ revealSessionRow, selectedSessionId, sessions });

    const isProjectExpanded = projectCollapse.isProjectExpanded;

    /**
     * One windowed Session list per Project, in sidebar order. Shared by the flattened tree rows and the rendered
     * groups so arrow-key navigation can never reach a Session the window hides.
     */
    const sessionWindows = useProjectSessionWindows({
        hostedByGroup: placement.hostedByGroup,
        projects: mergedProjects,
        selectedHostSessionId: delegated.selectedHostSessionId,
        selectedSessionId,
        sidebarSessions,
    });
    const projectWindows = sortByProjectOrder(
        sessionWindows.windows,
        projectOrder.orderedProjectIds,
        (entry) => entry.project.id,
    );
    /**
     * The collapse hover and the held Project order both follow the pointer in and out of the list.
     */
    const setIsPointerInside = (isInside: boolean): void => {
        projectCollapse.setIsHovered(isInside);
        projectOrder.onListPointerChange(isInside);
    };
    const pinnedSessionIds = useMemo(
        () => pinnedGroup.visibleSessions.map((session) => session.id),
        [pinnedGroup.visibleSessions],
    );
    const renderedSessions = useMemo(
        () => [
            ...projectWindows.flatMap((entry) => entry.visibleSessions),
            ...pinnedGroup.visibleSessions,
        ],
        [pinnedGroup.visibleSessions, projectWindows],
    );
    const { showSubagents, subagentNodes } = useSessionSubagentNodes(renderedSessions, terminals);
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
        delegatedNodes: delegated.children.rowNodes,
        hasHiddenPinnedSessions: pinnedGroup.hiddenCount > 0,
        isPinnedExpanded: pinnedCollapse.expanded,
        isProjectExpanded,
        pinnedSessionIds,
        projectWindows,
        selectedFallbackRowIds: delegated.selectedFallbackRowIds,
        selectedProjectId,
        selectedSessionId,
        subagentNodes,
        treeReference,
    });

    const { animatedProjectIds, togglePinnedGroup, toggleProject } = useGroupToggles(
        pinnedCollapse,
        projectCollapse,
    );

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

    const renderDelegatedRows = useRenderDelegatedRows({
        allProjects: allProjects ?? NO_RECORDS,
        delegated,
        focusRow,
        rovingRowId,
        selectedSessionId,
        sessionRename,
        sessions,
        terminals,
    });

    return (
        <div className="scroll-edge-shell relative min-h-0 flex-1">
            <div
                ref={projectListReference}
                className="project-list absolute inset-0 overflow-auto p-2"
                data-scrolled="false"
                onDragOver={(event) => {
                    if (
                        !(event.target instanceof Element) ||
                        !event.target.closest('.session-card:not([data-nested-session])')
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
                onPointerEnter={() => setIsPointerInside(true)}
                onPointerLeave={() => setIsPointerInside(false)}
            >
                <SessionSelectionGlideFill
                    list={projectListReference}
                    selectedSessionId={selectedSessionId}
                />
                {/*
                 * The tree element holds Project and Session rows and nothing else. The empty-state action and the
                 * live regions below sit outside it on purpose: inside a `role="tree"`, every focusable element has to
                 * be a real `treeitem` holding the tree's single roving Tab stop (DESIGN.md), and a static region is
                 * not a tree row at all. The scroll container, the Project drop target, and the hover/focus tracking
                 * stay on the wrapper so none of that changes with it.
                 */}
                <div
                    ref={treeReference}
                    aria-label={t('primarySidebar.tree.ariaLabel')}
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
                        renderDelegatedRows={renderDelegatedRows}
                        renameError={sessionRename.renameError}
                        renameSuggestingSessionId={sessionRename.renameSuggestingSessionId}
                        renameValue={sessionRename.renameValue}
                        renamingRowId={sessionRename.renamingRowId}
                        rovingRowId={rovingRowId}
                        selectedSessionId={selectedSessionId}
                        sessionOrder={pinnedGroup.sessionOrder}
                        sessions={pinnedGroup.sessions}
                        showSubagents={showSubagents}
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
                        renderDelegatedRows={renderDelegatedRows}
                        rovingRowId={rovingRowId}
                        selectedProjectId={selectedProjectId}
                        selectedSessionId={selectedSessionId}
                        sessionOrder={sessionOrder}
                        sessionRename={sessionRename}
                        showSubagents={showSubagents}
                        terminals={terminals}
                        worktreeProjects={worktreeProjects}
                    />
                </div>
                {/* The Welcome view beside it holds the one Add Project button; the sidebar only says why it is empty. */}
                {projects.length === 0 && (
                    <p className="m-0 px-2 py-1.5 text-[12px] text-muted">
                        {t('primarySidebar.tree.noProjects')}
                    </p>
                )}
                <PrimarySidebarLiveRegions
                    pinnedOrderAnnouncement={pinnedGroup.sessionOrder.announcement}
                    pinnedSessionAnnouncement={pinAnnouncement}
                    projectOrderAnnouncement={projectOrder.projectOrderAnnouncement}
                    sessionOrderAnnouncement={sessionOrder.announcement}
                />
            </div>
        </div>
    );
}
