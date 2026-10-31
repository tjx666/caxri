import { useMemo, useRef, useState } from 'react';

import { nextRevealedSessionCount } from '@caxri/protocol';

import { useRelativeTimes } from '@/hooks/use-relative-time';

import { useScrollEdge } from '../../hooks/use-scroll-edge';
import { useSessionExcerpts } from '../../hooks/use-session-excerpts';
import { useTranslation } from '../../i18n';
import {
    useProjects,
    useSelectedProject,
    useSelectedSession,
    useSessions,
    useTerminals,
} from '../../stores/selectors';
import { tryCommand } from '../../stores/toasts';
import { useSessionPullRequestPoll } from '../primary-sidebar/hooks/use-session-pull-request';
import { useSessionRename } from '../primary-sidebar/hooks/use-session-rename';
import { sessionWorktreeProject, topLevelProjects } from '../primary-sidebar/project-visibility';
import { SessionRevealRow } from '../primary-sidebar/session-reveal-row';
import { ActivitySessionCreationMenu } from '../session/create-session-menu';
import { sessionAgentTerminal } from '../session/session-agent-terminal';
import { markSessionRead } from '../session/session-commands';
import { AgentActivityHeading } from './agent-activity-heading';
import { AgentActivityRowItem } from './agent-activity-row-item';
import type {
    AgentActivityGroupId,
    AgentActivityRow,
    AgentActivitySelectionAnchor,
} from './agent-activity-rows';
import {
    agentActivityGroups,
    agentActivityHeadingPresentation,
    agentActivityRenameRow,
    agentActivitySelectionAnchor,
    isAgentActivitySelectionAnchorCurrent,
} from './agent-activity-rows';
import type { AgentActivityVerticalKey } from './agent-activity-tree';
import {
    flattenAgentActivityRows,
    nextAgentActivityRowId,
    rovingAgentActivityRowId,
} from './agent-activity-tree';
import { useAgentActivityClock } from './use-agent-activity-clock';
import { useAgentActivityGroupCollapse } from './use-agent-activity-group-collapse';

const NO_RECORDS: never[] = [];
const VERTICAL_KEYS: ReadonlySet<string> = new Set(['ArrowDown', 'ArrowUp', 'End', 'Home']);

/**
 * Every Project's Agent Sessions in one flat, attention-first list.
 *
 * The Project tree answers "which Sessions exist", grouped by Project and ordered by the user's own arrangement, so a
 * Session that needs attention is never promoted there. This list answers the other question: "which ones are waiting
 * on me". One list cannot hold both orders without the user losing the arrangement they chose, so the two take turns in
 * the Primary Side Bar's body rather than sharing it; see `primary-sidebar.tsx`.
 */
export function AgentActivityView() {
    const { t } = useTranslation();
    const now = useAgentActivityClock();
    const allProjects = useProjects();
    const sessions = useSessions() ?? NO_RECORDS;
    const terminals = useTerminals();
    const selectedSessionId = useSelectedSession()?.id;
    const [focusedRowId, setFocusedRowId] = useState<string>();
    const treeReference = useRef<HTMLDivElement>(null);
    const scrollReference = useRef<HTMLDivElement>(null);
    const selectedProject = useSelectedProject();
    const creationProjects = useMemo(
        () => topLevelProjects(allProjects ?? NO_RECORDS),
        [allProjects],
    );
    /**
     * The Project `session.create` targets (the selected Session's), so the row and the shortcut agree. A selection in
     * a hidden worktree Project falls back to the first listed Project, since the menu cannot name a hidden one.
     */
    const defaultCreationProject =
        creationProjects.find((project) => project.id === selectedProject?.id) ??
        creationProjects.at(0);
    const groupCollapse = useAgentActivityGroupCollapse();
    /**
     * How far each windowed group was revealed. Kept in memory only, like the Project tree's windows: a relaunch starts
     * from the short lists again, the same way it starts scrolled to the top.
     */
    const [revealedCounts, setRevealedCounts] = useState<
        Partial<Record<AgentActivityGroupId, number>>
    >({});
    // The Project tree's own inset-shadow scroll cue (`primary-sidebar-project-tree.tsx`), bound to this queue's
    // scroller too: `.scroll-edge-shell`'s `::after` in styles.css reads the `data-scrolled` attribute this sets.
    useScrollEdge(scrollReference);
    // Owns the cadence only; each row subscribes to its own slice of the snapshot this keeps fresh.
    useSessionPullRequestPoll();

    const canonicalGroups = useMemo(
        () =>
            agentActivityGroups({
                now,
                // Auto-registered worktree Projects are hidden from the PrimarySidebar's top level, so naming one here
                // would point at a row the user has no other way to reach.
                projects: topLevelProjects(allProjects ?? NO_RECORDS),
                sessions,
                t,
                terminals,
            }),
        [allProjects, now, sessions, t, terminals],
    );
    /**
     * Capture the unread generation on the selection render, before the visibility acknowledgement reaches the Server.
     * React retries this component immediately after the guarded state adjustment, so children only see the new
     * anchor.
     */
    const [selection, setSelection] = useState<{
        anchor: AgentActivitySelectionAnchor | undefined;
        sessionId: string | undefined;
    }>(() => ({
        anchor: agentActivitySelectionAnchor(canonicalGroups, selectedSessionId),
        sessionId: selectedSessionId,
    }));
    let selectionAnchor = selection.anchor;
    if (selection.sessionId !== selectedSessionId) {
        selectionAnchor = agentActivitySelectionAnchor(canonicalGroups, selectedSessionId);
        setSelection({ anchor: selectionAnchor, sessionId: selectedSessionId });
    } else if (selectionAnchor) {
        const anchoredSession = sessions.find(
            (session) => session.id === selectionAnchor?.sessionId,
        );
        if (
            !isAgentActivitySelectionAnchorCurrent(
                selectionAnchor,
                anchoredSession,
                anchoredSession ? sessionAgentTerminal(anchoredSession, terminals) : undefined,
            )
        ) {
            selectionAnchor = undefined;
            setSelection({ anchor: undefined, sessionId: selectedSessionId });
        }
    }
    const groups = useMemo(
        () =>
            selectionAnchor?.sessionId === selectedSessionId
                ? agentActivityGroups({
                      now,
                      projects: topLevelProjects(allProjects ?? NO_RECORDS),
                      selectionAnchor,
                      sessions,
                      t,
                      terminals,
                  })
                : canonicalGroups,
        [
            allProjects,
            canonicalGroups,
            now,
            selectedSessionId,
            selectionAnchor,
            sessions,
            t,
            terminals,
        ],
    );
    const rows = useMemo(
        () =>
            flattenAgentActivityRows(groups, {
                collapsedGroupIds: groupCollapse.collapsedGroupIds,
                revealedCounts,
                selectedSessionId,
            }),
        [groupCollapse.collapsedGroupIds, groups, revealedCounts, selectedSessionId],
    );
    const rovingRowId = rovingAgentActivityRowId(rows, focusedRowId, selectedSessionId);
    const sessionRows = useMemo(() => groups.flatMap((group) => group.rows), [groups]);
    const attentionSessions = useMemo(
        () => sessionRows.filter((row) => row.groupId === 'attention').map((row) => row.session),
        [sessionRows],
    );
    const excerpts = useSessionExcerpts(attentionSessions);
    const visibleSessions = useMemo(() => sessionRows.map((row) => row.session), [sessionRows]);
    const sessionRename = useSessionRename(visibleSessions, (session) => {
        const target = agentActivityRenameRow(groups, session.id, groupCollapse.collapsedGroupIds);
        if (target.expandGroupId) groupCollapse.expand(target.expandGroupId);
        return target.rowId;
    });
    const headings = useMemo(
        () =>
            new Map(groups.map((group) => [group.id, agentActivityHeadingPresentation(group, t)])),
        [groups, t],
    );
    /**
     * `narrow` ("8m ago") rather than the prose form the Session cards use. A row here spends its one line on a Project
     * name, a state phrase, and this, inside a side bar the user can drag down to 180px; "8 minutes ago" costs roughly
     * twice the width and buys nothing a queue needs.
     */
    const relativeTimes = useRelativeTimes(
        useMemo(() => sessionRows.map((row) => row.session.sessionActivityAt), [sessionRows]),
        'narrow',
    );
    /**
     * Resolved against every Project, not just the top-level ones the rows are drawn from: an auto-registered worktree
     * Project is exactly the kind the side bar hides, and naming it is the point.
     */
    const worktreeProjectBySessionId = useMemo(
        () =>
            new Map(
                sessionRows.map(
                    (row) =>
                        [
                            row.session.id,
                            sessionWorktreeProject(row.session, allProjects ?? NO_RECORDS),
                        ] as const,
                ),
            ),
        [allProjects, sessionRows],
    );
    const relativeTimeBySessionId = useMemo(
        () =>
            new Map(
                sessionRows.map((row, index) => [row.session.id, relativeTimes[index]] as const),
            ),
        [relativeTimes, sessionRows],
    );

    /**
     * Outside the tree: it is not a row of the queue, and inside `role="tree"` a focusable element has to be one. It
     * stays above the scroller so the entry never scrolls away behind a long queue.
     */
    const newSessionRow =
        defaultCreationProject === undefined ? null : (
            <div className="agent-activity-new-session-bar flex-none px-2 pt-2">
                <ActivitySessionCreationMenu
                    defaultProject={defaultCreationProject}
                    projects={creationProjects}
                />
            </div>
        );

    if (groups.length === 0)
        return (
            <div className="flex min-h-0 flex-1 flex-col">
                {newSessionRow}
                <div className="agent-activity-empty flex min-h-0 flex-1 items-center justify-center p-6 text-center text-xs text-muted">
                    {t('agentActivity.empty')}
                </div>
            </div>
        );

    const focusRow = (rowId: string): void => {
        setFocusedRowId(rowId);
        treeReference.current
            ?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(rowId)}"]`)
            ?.focus();
    };

    const markRead = (row: AgentActivityRow): void => {
        /**
         * Where focus lands is decided before the acknowledgement is sent, the same way archiving does it in
         * `primary-sidebar-tree-keys.ts`: clearing a reminder is a queue action people repeat, so focus has to advance
         * to the next row rather than follow the one that just left "Needs attention".
         */
        const sessionTreeRows = rows.filter((candidate) => candidate.kind === 'session');
        const focusAfterRead =
            nextAgentActivityRowId(sessionTreeRows, row.rowId, 'ArrowDown') ??
            nextAgentActivityRowId(sessionTreeRows, row.rowId, 'ArrowUp');
        setSelection((current) =>
            current.anchor?.sessionId === row.session.id
                ? { ...current, anchor: undefined }
                : current,
        );
        // Fire-and-forget: `tryCommand` turns any rejection into exactly one toast, and the Server keeps the same
        // generation unread so the next focus event can retry it.
        void tryCommand(t('agentActivity.markReadFailed'), () =>
            markSessionRead(row.session.id, row.session.attentionGeneration),
        );
        if (focusAfterRead) focusRow(focusAfterRead);
    };

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            {newSessionRow}
            <div className="scroll-edge-shell relative min-h-0 flex-1">
                <div
                    ref={scrollReference}
                    className="agent-activity absolute inset-0 overflow-auto p-2"
                    data-scrolled="false"
                >
                    <div
                        ref={treeReference}
                        aria-label={t('agentActivity.treeLabel')}
                        className="flex flex-col gap-0.5"
                        role="tree"
                        onKeyDown={(event) => {
                            if (event.target instanceof HTMLInputElement) return;
                            // Same guard as `handlePrimarySidebarTreeKey`: an unbound chord such as macOS's Cmd+Down ("scroll to
                            // bottom") must keep its native meaning rather than being eaten as a row move.
                            if (event.altKey || event.metaKey || event.ctrlKey) return;
                            if (!VERTICAL_KEYS.has(event.key)) return;
                            const nextRowId = nextAgentActivityRowId(
                                rows,
                                focusedRowId,
                                event.key as AgentActivityVerticalKey,
                            );
                            if (!nextRowId) return;
                            event.preventDefault();
                            focusRow(nextRowId);
                        }}
                    >
                        {rows.map((entry) => {
                            if (entry.kind === 'group') {
                                const heading = headings.get(entry.id);
                                if (!heading) return null;
                                return (
                                    <AgentActivityHeading
                                        key={entry.id}
                                        expanded={entry.expanded}
                                        group={entry.group}
                                        heading={heading}
                                        roving={rovingRowId === entry.id}
                                        onFocus={() => setFocusedRowId(entry.id)}
                                        onToggle={() => groupCollapse.toggle(entry.id)}
                                    />
                                );
                            }
                            if (entry.kind === 'reveal')
                                return (
                                    <SessionRevealRow
                                        key={entry.id}
                                        ariaLabel={t(
                                            entry.nextRevealCount === 1
                                                ? 'agentActivity.revealAriaLabelOne'
                                                : 'agentActivity.revealAriaLabelOther',
                                            {
                                                count: entry.nextRevealCount,
                                                group: headings.get(entry.groupId)?.label ?? '',
                                            },
                                        )}
                                        count={entry.nextRevealCount}
                                        roving={rovingRowId === entry.id}
                                        rowId={entry.id}
                                        onReveal={() => {
                                            setFocusedRowId(entry.id);
                                            setRevealedCounts((current) => ({
                                                ...current,
                                                [entry.groupId]: nextRevealedSessionCount(
                                                    entry.windowCount,
                                                ),
                                            }));
                                        }}
                                    />
                                );
                            return (
                                <AgentActivityRowItem
                                    key={entry.id}
                                    excerpt={excerpts[entry.sessionId]}
                                    inPinnedGroup={entry.row.rowId !== entry.sessionId}
                                    relativeTime={relativeTimeBySessionId.get(entry.sessionId)}
                                    roving={rovingRowId === entry.id}
                                    row={entry.row}
                                    selected={selectedSessionId === entry.sessionId}
                                    sessionRename={sessionRename}
                                    worktreeProject={worktreeProjectBySessionId.get(
                                        entry.sessionId,
                                    )}
                                    onFocusChange={setFocusedRowId}
                                    onMarkRead={() => markRead(entry.row)}
                                />
                            );
                        })}
                    </div>
                </div>
            </div>
        </div>
    );
}
