import { useMemo, useRef, useState } from 'react';

import { useRelativeTimes } from '@/hooks/use-relative-time';

import { useProjects, useSelectedSession, useSessions, useTerminals } from '../../stores/selectors';
import { tryCommand } from '../../stores/toasts';
import { topLevelProjects } from '../primary-sidebar/project-visibility';
import { markSessionRead } from '../session/session-commands';
import { AgentActivityRowItem } from './agent-activity-row-item';
import type { AgentActivityGroup, AgentActivityRow } from './agent-activity-rows';
import { agentActivityGroups } from './agent-activity-rows';
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
    { group: AgentActivityGroup; kind: 'heading' } | { kind: 'session'; row: AgentActivityRow };

/**
 * Every Project's Agent Sessions in one flat, attention-first list.
 *
 * The PrimarySidebar answers "which Sessions exist", grouped by Project and ordered by the user's own arrangement, so a
 * Session that needs attention is never promoted there. This view answers the other question — "which ones are waiting
 * on me" — which is why it is a separate container rather than a mode switch on that tree: the two orders are genuinely
 * different, and one list cannot hold both without the user losing the arrangement they chose.
 */
export function AgentActivityView() {
    const now = useAgentActivityClock();
    const allProjects = useProjects();
    const sessions = useSessions() ?? NO_RECORDS;
    const terminals = useTerminals();
    const selectedSessionId = useSelectedSession()?.id;
    const [focusedRowId, setFocusedRowId] = useState<string>();
    const treeReference = useRef<HTMLDivElement>(null);

    const groups = useMemo(
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
    const rows = useMemo(() => flattenAgentActivityRows(groups), [groups]);
    const rovingRowId = rovingAgentActivityRowId(rows, focusedRowId, selectedSessionId);
    const sessionRows = useMemo(() => groups.flatMap((group) => group.rows), [groups]);
    /**
     * Headings and Session rows are rendered as one keyed sequence under a single parent rather than one fragment per
     * group. A Session that changes state moves between groups constantly, and a per-group fragment makes that a change
     * of parent — React unmounts the row and rebuilds it, so a focused row loses focus to `<body>` every time the Agent
     * it describes does anything. Keyed siblings are moved instead.
     */
    const renderRows = useMemo(
        () =>
            groups.flatMap<RenderRow>((group) => [
                { group, kind: 'heading' },
                ...group.rows.map((row) => ({ kind: 'session' as const, row })),
            ]),
        [groups],
    );
    const relativeTimes = useRelativeTimes(
        useMemo(() => sessionRows.map((row) => row.session.lastSessionActivityAt), [sessionRows]),
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
                No Agent Session is waiting on you.
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
            nextAgentActivityRowId(rows, row.session.id, 'ArrowDown') ??
            nextAgentActivityRowId(rows, row.session.id, 'ArrowUp');
        // Fire-and-forget: `tryCommand` turns any rejection into exactly one toast, and the Server keeps the same
        // generation unread so the next focus event can retry it.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void tryCommand('Unable to mark the Session read', () =>
            markSessionRead(row.session.id, row.session.attentionEpoch),
        );
        if (focusAfterRead) focusRow(focusAfterRead);
    };

    return (
        <div className="agent-activity min-h-0 flex-1 overflow-auto p-2">
            <div
                ref={treeReference}
                aria-label="Activity"
                className="flex flex-col gap-0.5"
                role="tree"
                onKeyDown={(event) => {
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
                        /*
                         * A heading is a `treeitem` because everything inside `role="tree"` has to be one, but an
                         * `aria-disabled` one with no Tab stop: these groups are derived from Agent state and cannot be
                         * collapsed, so there is no action to land focus on. Arrow keys step over it, the same way
                         * DESIGN.md has them step over a branch placeholder.
                         */
                        <div
                            key={entry.group.id}
                            aria-disabled="true"
                            aria-level={1}
                            className="agent-activity-heading mt-2 flex items-center gap-1.5 px-2 pb-1 text-[11px] font-medium text-muted first:mt-0"
                            data-activity-group={entry.group.id}
                            data-row-id={entry.group.id}
                            role="treeitem"
                        >
                            <span>{entry.group.label}</span>
                            <span aria-hidden="true">{entry.group.rows.length}</span>
                            <span className="sr-only">
                                {`${entry.group.rows.length} ${entry.group.rows.length === 1 ? 'Session' : 'Sessions'}`}
                            </span>
                        </div>
                    ) : (
                        <AgentActivityRowItem
                            key={entry.row.session.id}
                            relativeTime={relativeTimeBySessionId.get(entry.row.session.id)}
                            roving={rovingRowId === entry.row.session.id}
                            row={entry.row}
                            selected={selectedSessionId === entry.row.session.id}
                            onFocusChange={setFocusedRowId}
                            onMarkRead={() => markRead(entry.row)}
                        />
                    ),
                )}
            </div>
        </div>
    );
}
