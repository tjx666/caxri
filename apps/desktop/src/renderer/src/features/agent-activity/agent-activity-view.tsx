import { useMemo, useRef, useState } from 'react';

import { defaultAppSettings, nextRevealedSessionCount } from '@caxri/protocol';

import { useRelativeTimes } from '@/hooks/use-relative-time';

import { useScrollEdge } from '../../hooks/use-scroll-edge';
import { useSessionExcerpts } from '../../hooks/use-session-excerpts';
import { useTranslation } from '../../i18n';
import { isTreeVerticalKey } from '../../lib/tree-navigation';
import {
    useProjects,
    useSelectedSession,
    useSessions,
    useSettings,
    useTerminals,
} from '../../stores/selectors';
import { tryCommand } from '../../stores/toasts';
import { useSessionPullRequestPoll } from '../primary-sidebar/hooks/use-session-pull-request';
import { useSessionRename } from '../primary-sidebar/hooks/use-session-rename';
import { sessionWorktreeProject, topLevelProjects } from '../primary-sidebar/project-visibility';
import { SessionRevealRow } from '../primary-sidebar/session-reveal-row';
import { didMarkSessionDone } from '../session/session-commands';
import { AgentActivityHeading } from './agent-activity-heading';
import { AgentActivityNewSessionBar } from './agent-activity-new-session-bar';
import { AgentActivityRowItem } from './agent-activity-row-item';
import type { AgentActivityGroupId, AgentActivityRow } from './agent-activity-rows';
import {
    agentActivityGroups,
    agentActivityHeadingPresentation,
    agentActivityRenameRow,
} from './agent-activity-rows';
import {
    flattenAgentActivityRows,
    focusRestoreRowIdAfterMarkDone,
    nextAgentActivityRowId,
    rovingAgentActivityRowId,
} from './agent-activity-tree';
import { useAgentActivityExpandScroll } from './hooks/use-agent-activity-expand-scroll';
import {
    useAgentActivityAutoExpand,
    useAgentActivityGroupCollapse,
} from './hooks/use-agent-activity-group-collapse';
import { useMergedPullRequestSessionIds } from './hooks/use-merged-pull-request-session-ids';

const NO_RECORDS: never[] = [];

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
    const allProjects = useProjects();
    const sessions = useSessions() ?? NO_RECORDS;
    const terminals = useTerminals();
    const showExcerpts = (useSettings() ?? defaultAppSettings)['agentActivity.showExcerpts'];
    const selectedSessionId = useSelectedSession()?.id;
    const [focusedRowId, setFocusedRowIdState] = useState<string>();
    /**
     * Mirrors `focusedRowId` for async callbacks that must read the latest focus, not the render they closed over.
     */
    const focusedRowReference = useRef<string | undefined>(undefined);
    const setFocusedRowId = (rowId: string | undefined): void => {
        focusedRowReference.current = rowId;
        setFocusedRowIdState(rowId);
    };
    const treeReference = useRef<HTMLDivElement>(null);
    const scrollReference = useRef<HTMLDivElement>(null);
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
    const mergedPullRequestSessionIds = useMergedPullRequestSessionIds();

    const groups = useMemo(
        () =>
            agentActivityGroups({
                mergedPullRequestSessionIds,
                // Auto-registered worktree Projects are hidden from the PrimarySidebar's top level, so naming one here
                // would point at a row the user has no other way to reach.
                projects: topLevelProjects(allProjects ?? NO_RECORDS),
                sessions,
                terminals,
            }),
        [allProjects, mergedPullRequestSessionIds, sessions, terminals],
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
        () =>
            groups.find((group) => group.id === 'attention')?.rows.map((row) => row.session) ?? [],
        [groups],
    );
    const excerpts = useSessionExcerpts(attentionSessions, showExcerpts);
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
    useAgentActivityAutoExpand(headings, groupCollapse.collapsedGroupIds, groupCollapse.expand);
    const markExpandScroll = useAgentActivityExpandScroll(scrollReference, rows);
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

    if (groups.length === 0)
        return (
            <div className="flex min-h-0 flex-1 flex-col">
                <AgentActivityNewSessionBar />
                <div className="agent-activity-empty flex min-h-0 flex-1 items-center justify-center p-6 text-center text-xs text-muted">
                    <div className="flex flex-col gap-1">
                        <span>{t('agentActivity.empty')}</span>
                        <span>{t('agentActivity.emptyHint')}</span>
                    </div>
                </div>
            </div>
        );

    const focusRow = (rowId: string): void => {
        setFocusedRowId(rowId);
        treeReference.current
            ?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(rowId)}"]`)
            ?.focus();
    };

    const markDone = (row: AgentActivityRow): void => {
        /**
         * Where focus lands is decided before the acknowledgement is sent, the same way archiving does it in
         * `primary-sidebar-tree-keys.ts`: resolving an item is a queue action people repeat, so focus has to advance to
         * the next row rather than follow the one that just left "Needs attention".
         */
        const sessionTreeRows = rows.filter((candidate) => candidate.kind === 'session');
        const focusAfterRead =
            nextAgentActivityRowId(sessionTreeRows, row.rowId, 'ArrowDown') ??
            nextAgentActivityRowId(sessionTreeRows, row.rowId, 'ArrowUp');
        // Fire-and-forget: `tryCommand` turns any rejection into exactly one toast, and the Server keeps the Session
        // pending so the user can retry. A failure or `resolved: false` leaves the Session in "Needs attention", so
        // focus returns to it instead of staying on the row it was pre-advanced to.
        void tryCommand(t('agentActivity.markDoneFailed'), () =>
            didMarkSessionDone(row.session.id, row.session.attentionGeneration),
        ).then((resolved) => {
            const restoreRowId = focusRestoreRowIdAfterMarkDone({
                currentFocusedRowId: focusedRowReference.current,
                markedRowId: row.rowId,
                plannedRowId: focusAfterRead,
                resolved: resolved === true,
            });
            if (restoreRowId) focusRow(restoreRowId);
        });
        if (focusAfterRead) focusRow(focusAfterRead);
    };

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <AgentActivityNewSessionBar />
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
                            const { key } = event;
                            if (!isTreeVerticalKey(key)) return;
                            const nextRowId = nextAgentActivityRowId(rows, focusedRowId, key);
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
                                        onToggle={() => {
                                            if (!entry.expanded) markExpandScroll(entry.id);
                                            groupCollapse.toggle(entry.id);
                                        }}
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
                                    showExcerpts={showExcerpts}
                                    worktreeProject={worktreeProjectBySessionId.get(
                                        entry.sessionId,
                                    )}
                                    onFocusChange={setFocusedRowId}
                                    onMarkDone={() => markDone(entry.row)}
                                />
                            );
                        })}
                    </div>
                </div>
            </div>
        </div>
    );
}
