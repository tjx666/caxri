import { useMemo, useRef, useState } from 'react';

import { useRelativeTimes } from '@/hooks/use-relative-time';

import { useScrollEdge } from '../../hooks/use-scroll-edge';
import { useSessionExcerpts } from '../../hooks/use-session-excerpts';
import { useTranslation } from '../../i18n';
import { useProjects, useSelectedSession, useSessions, useTerminals } from '../../stores/selectors';
import { tryCommand } from '../../stores/toasts';
import { usePinnedCollapse } from '../primary-sidebar/hooks/use-pinned-collapse';
import { useSessionPullRequestPoll } from '../primary-sidebar/hooks/use-session-pull-request';
import { useSessionRename } from '../primary-sidebar/hooks/use-session-rename';
import { sessionWorktreeProject, topLevelProjects } from '../primary-sidebar/project-visibility';
import { sessionAgentTerminal } from '../session/session-agent-terminal';
import { markSessionRead } from '../session/session-commands';
import { AgentActivityHeading } from './agent-activity-heading';
import { AgentActivityRowItem } from './agent-activity-row-item';
import type {
    AgentActivityGroup,
    AgentActivityRow,
    AgentActivitySelectionAnchor,
} from './agent-activity-rows';
import {
    agentActivityGroups,
    agentActivityHeadingPresentation,
    agentActivityPinnedRowId,
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

const NO_RECORDS: never[] = [];
const VERTICAL_KEYS: ReadonlySet<string> = new Set(['ArrowDown', 'ArrowUp', 'End', 'Home']);

type RenderRow =
    | {
          group: AgentActivityGroup;
          heading: ReturnType<typeof agentActivityHeadingPresentation>;
          kind: 'heading';
      }
    | { kind: 'session'; row: AgentActivityRow };

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
    /**
     * Shares the Project tree Pinned group's remembered disclosure state: both bodies show the same pinned Sessions, so
     * collapsing them in one and finding them open in the other would read as two different features.
     */
    const pinnedCollapse = usePinnedCollapse();
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
                terminals,
            }),
        [allProjects, now, sessions, terminals],
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
            terminals,
        ],
    );
    const rows = useMemo(
        () => flattenAgentActivityRows(groups, { pinnedExpanded: pinnedCollapse.expanded }),
        [groups, pinnedCollapse.expanded],
    );
    const rovingRowId = rovingAgentActivityRowId(rows, focusedRowId, selectedSessionId);
    const sessionRows = useMemo(() => groups.flatMap((group) => group.rows), [groups]);
    const attentionSessions = useMemo(
        () => sessionRows.filter((row) => row.groupId === 'attention').map((row) => row.session),
        [sessionRows],
    );
    const excerpts = useSessionExcerpts(attentionSessions);
    const visibleSessions = useMemo(() => sessionRows.map((row) => row.session), [sessionRows]);
    /**
     * A command-driven rename (`session.rename`) edits the Session's first rendered copy. A Session listed only under a
     * collapsed Pinned group has no rendered row, so the group opens first.
     */
    const sessionRename = useSessionRename(visibleSessions, (session) => {
        const statusRow = groups
            .filter((group) => group.id !== 'pinned')
            .flatMap((group) => group.rows)
            .find((row) => row.session.id === session.id);
        if (!statusRow || pinnedCollapse.expanded) {
            pinnedCollapse.expand();
            return agentActivityPinnedRowId(session.id);
        }
        return statusRow.rowId;
    });
    /**
     * Headings and Session rows are rendered as one keyed sequence under a single parent rather than one fragment per
     * group. A Session that changes state moves between groups constantly, and a per-group fragment makes that a change
     * of parent; React unmounts the row and rebuilds it, so a focused row loses focus to `<body>` every time the Agent
     * it describes does anything. Keyed siblings are moved instead.
     */
    const renderRows = useMemo(
        () =>
            groups.flatMap<RenderRow>((group) => [
                { group, heading: agentActivityHeadingPresentation(group, t), kind: 'heading' },
                ...(!pinnedCollapse.expanded && group.id === 'pinned'
                    ? []
                    : group.rows.map((row) => ({ kind: 'session' as const, row }))),
            ]),
        [groups, pinnedCollapse.expanded, t],
    );
    /**
     * `narrow` ("8m ago") rather than the prose form the Session cards use. A row here spends its one line on a Project
     * name, a state phrase, and this, inside a side bar the user can drag down to 180px; "8 minutes ago" costs roughly
     * twice the width and buys nothing a queue needs.
     */
    const relativeTimes = useRelativeTimes(
        useMemo(() => sessionRows.map((row) => row.session.lastSessionActivityAt), [sessionRows]),
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
            <div className="agent-activity-empty flex min-h-0 flex-1 items-center justify-center p-6 text-center text-xs text-muted">
                {t('agentActivity.empty')}
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
        const focusAfterRead =
            nextAgentActivityRowId(rows, row.rowId, 'ArrowDown') ??
            nextAgentActivityRowId(rows, row.rowId, 'ArrowUp');
        setSelection((current) =>
            current.anchor?.sessionId === row.session.id
                ? { ...current, anchor: undefined }
                : current,
        );
        // Fire-and-forget: `tryCommand` turns any rejection into exactly one toast, and the Server keeps the same
        // generation unread so the next focus event can retry it.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void tryCommand(t('agentActivity.markReadFailed'), () =>
            markSessionRead(row.session.id, row.session.attentionEpoch),
        );
        if (focusAfterRead) focusRow(focusAfterRead);
    };

    return (
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
                    {renderRows.map((entry) =>
                        entry.kind === 'heading' ? (
                            <AgentActivityHeading
                                key={entry.group.id}
                                group={entry.group}
                                heading={entry.heading}
                                pinnedDisclosure={
                                    entry.group.id === 'pinned'
                                        ? {
                                              expanded: pinnedCollapse.expanded,
                                              roving: rovingRowId === entry.group.id,
                                              onFocus: () => setFocusedRowId(entry.group.id),
                                              onToggle: pinnedCollapse.toggle,
                                          }
                                        : undefined
                                }
                            />
                        ) : (
                            <AgentActivityRowItem
                                key={entry.row.rowId}
                                excerpt={excerpts[entry.row.session.id]}
                                inPinnedGroup={entry.row.rowId !== entry.row.session.id}
                                relativeTime={relativeTimeBySessionId.get(entry.row.session.id)}
                                roving={rovingRowId === entry.row.rowId}
                                row={entry.row}
                                selected={selectedSessionId === entry.row.session.id}
                                sessionRename={sessionRename}
                                worktreeProject={worktreeProjectBySessionId.get(
                                    entry.row.session.id,
                                )}
                                onFocusChange={setFocusedRowId}
                                onMarkRead={() => markRead(entry.row)}
                            />
                        ),
                    )}
                </div>
            </div>
        </div>
    );
}
