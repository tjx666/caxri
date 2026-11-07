import type {
    ProjectRecord,
    SessionActivityGroupId,
    SessionActivityRowOrder,
    SessionRecord,
    TerminalRecord,
} from '@caxri/protocol';
import {
    compareSessionActivityGroupRows,
    compareSessionPinnedOrder,
    isPinnedSession,
    isSessionAgentRunning,
    PINNED_DUPLICATE_SESSION_ACTIVITY_GROUPS,
    SESSION_ACTIVITY_GROUP_ORDER,
    sessionActivityGroup,
} from '@caxri/protocol';

import type { Translate, TranslationKey } from '../../i18n';
import {
    indexedSessionAgentTerminal,
    sessionTerminalIndex,
} from '../session/session-agent-terminal';

/**
 * The state-derived groups. A row always carries one of these, including a row listed under `pinned`, because the row's
 * second line is decided by the Agent's state rather than by where the row happens to sit.
 */
type AgentActivityStatusGroupId = SessionActivityGroupId;

export type AgentActivityGroupId = 'pinned' | AgentActivityStatusGroupId;

export interface AgentActivityRow {
    groupId: AgentActivityStatusGroupId;
    /**
     * Unique within the rendered tree. A pinned Session can be listed twice (under `pinned` and under an actionable
     * status group), so the Pinned group's copy is namespaced and every other row uses the Session id.
     */
    rowId: string;
    /**
     * Owning Project, named on the row's second line because the list is flat: without it a row cannot say which
     * repository it belongs to. The whole record rather than its name, because the row's hover card and context menu
     * act on the Project too.
     */
    project: ProjectRecord;
    session: SessionRecord;
    /**
     * The turn ended but background work it started still runs (`agentOperation === 'background'`); the row says so on
     * its second line, and the working group ranks it first.
     */
    isBackgroundWait: boolean;
    terminal: TerminalRecord | undefined;
}

export interface AgentActivityGroup {
    id: AgentActivityGroupId;
    rows: AgentActivityRow[];
}

const GROUP_LABEL_KEYS: Record<AgentActivityGroupId, TranslationKey> = {
    pinned: 'agentActivity.group.pinned',
    attention: 'agentActivity.group.attention',
    idle: 'agentActivity.group.idle',
    working: 'agentActivity.group.working',
};

/**
 * Heading words for one group. Components pass their `useTranslation()` `t` so a language change re-renders the
 * heading.
 */
export function agentActivityHeadingPresentation(
    group: AgentActivityGroup,
    t: Translate,
): {
    count: number | undefined;
    label: string;
    summary: string;
} {
    const count = group.rows.length;
    return {
        count,
        label: t(GROUP_LABEL_KEYS[group.id]),
        summary: t(
            count === 1
                ? 'agentActivity.heading.sessionsOne'
                : 'agentActivity.heading.sessionsOther',
            { count },
        ),
    };
}

/**
 * The shared grouping rule fed from the Session and its Primary Agent Terminal rather than from `sessionStatus`: that
 * projection lets unread attention mask a running turn, which would file a working Agent under Needs attention.
 */
function groupForSession(
    session: SessionRecord,
    terminal: TerminalRecord | undefined,
): AgentActivityStatusGroupId {
    return sessionActivityGroup({
        hasPendingAttention: session.hasPendingAttention,
        isDetached: terminal?.lastProcessState === 'detached',
        isRunning: isSessionAgentRunning(session, terminal),
        isUsageWaiting: terminal?.usageLimitWaitAt !== undefined,
    });
}

/**
 * Projects every Project's active Sessions into one flat, attention-first list: Needs attention, Working, Idle.
 *
 * Archived Sessions are excluded, and a Session whose Project is not in `projects` is dropped: the PrimarySidebar hides
 * auto-registered worktree Projects, and a row naming a Project the user never added would be unreachable from here.
 * Rows inside a status group follow `compareSessionActivityGroupRows`, shared with the phone. Pinned Sessions also get
 * a leading `pinned` group (see `PINNED_DUPLICATE_SESSION_ACTIVITY_GROUPS` for which ones stay in their status group
 * too).
 *
 * Terminals are grouped by Session once per call, so one projection is linear in Sessions plus Terminals. It has two
 * callers and neither runs while the queue is off screen: `AgentActivityView` exists only while the Primary Side Bar
 * shows Activity (`PrimarySidebar` unmounts the body it hides, and `App` unmounts a collapsed side bar), and
 * `session.focusNextAttention` computes its own copy from the store on demand, so the shortcut still works when the
 * queue was never opened (issue caxri#1111).
 */
export function agentActivityGroups({
    projects,
    sessions,
    terminals,
}: {
    projects: readonly ProjectRecord[];
    sessions: readonly SessionRecord[];
    terminals: readonly TerminalRecord[];
}): AgentActivityGroup[] {
    const projectsById = new Map(projects.map((project) => [project.id, project]));
    const terminalsBySession = sessionTerminalIndex(terminals);
    const entriesByGroup = new Map<
        AgentActivityStatusGroupId,
        Array<{ order: SessionActivityRowOrder; row: AgentActivityRow }>
    >();
    const pinnedRows: AgentActivityRow[] = [];
    for (const session of sessions) {
        if (session.archivedAt !== undefined) continue;
        const project = projectsById.get(session.projectId);
        if (project === undefined) continue;
        const terminal = indexedSessionAgentTerminal(session, terminalsBySession);
        const groupId = groupForSession(session, terminal);
        const isBackgroundWait = terminal?.agentOperation === 'background';
        const row: AgentActivityRow = {
            groupId,
            isBackgroundWait,
            project,
            rowId: session.id,
            session,
            terminal,
        };
        const pinned = isPinnedSession(session);
        if (pinned) pinnedRows.push({ ...row, rowId: agentActivityPinnedRowId(session.id) });
        if (pinned && !PINNED_DUPLICATE_SESSION_ACTIVITY_GROUPS.has(groupId)) continue;
        const entry = {
            order: {
                attentionResolvedAt: session.attentionResolvedAt,
                id: session.id,
                lastAttentionKind: session.lastAttentionKind,
                sessionActivityAt: session.sessionActivityAt,
                turnStartedAt: session.turnStartedAt,
            },
            row,
        };
        const existing = entriesByGroup.get(groupId);
        if (existing) existing.push(entry);
        else entriesByGroup.set(groupId, [entry]);
    }
    const statusGroups = SESSION_ACTIVITY_GROUP_ORDER.flatMap((id) => {
        const entries = entriesByGroup.get(id);
        if (!entries || entries.length === 0) return [];
        return [
            {
                id,
                rows: entries
                    .toSorted((left, right) =>
                        compareSessionActivityGroupRows(id, left.order, right.order),
                    )
                    .map((entry) => entry.row),
            },
        ];
    });
    if (pinnedRows.length === 0) return statusGroups;
    /**
     * Pinned comes first and keeps the user's own Pinned order rather than activity recency: a pin promises a fixed
     * place, the same one the Project tree's Pinned group gives it, so the row must not move as its Agent works.
     */
    return [
        {
            id: 'pinned',
            rows: pinnedRows.toSorted((left, right) =>
                compareSessionPinnedOrder(left.session, right.session),
            ),
        },
        ...statusGroups,
    ];
}

/**
 * Row id of a Session's copy inside the Pinned group. The prefix cannot collide with a Session id, which is an opaque
 * identifier with no `pinned:` scheme.
 */
function agentActivityPinnedRowId(sessionId: string): string {
    return `pinned:${sessionId}`;
}

/**
 * The row a command-driven rename (`session.rename`) edits: the Session's first rendered copy. Only a pinned Session
 * has a Pinned copy, and it renders first while the Pinned group is open; an unpinned Session must keep its status row,
 * or the editor targets a row that does not exist and the command silently does nothing (issue #2629). A row inside a
 * collapsed group is not rendered, so `expandGroupId` asks the caller to open that group first.
 */
export function agentActivityRenameRow(
    groups: readonly AgentActivityGroup[],
    sessionId: string,
    collapsedGroupIds: ReadonlySet<AgentActivityGroupId>,
): { expandGroupId: AgentActivityGroupId | undefined; rowId: string } {
    const isPinned = groups.some(
        (group) => group.id === 'pinned' && group.rows.some((row) => row.session.id === sessionId),
    );
    const statusRow = groups
        .filter((group) => group.id !== 'pinned')
        .flatMap((group) => group.rows)
        .find((row) => row.session.id === sessionId);
    const pinnedCollapsed = collapsedGroupIds.has('pinned');
    if (isPinned && (!pinnedCollapsed || !statusRow))
        return {
            expandGroupId: pinnedCollapsed ? 'pinned' : undefined,
            rowId: agentActivityPinnedRowId(sessionId),
        };
    return {
        expandGroupId:
            statusRow && collapsedGroupIds.has(statusRow.groupId) ? statusRow.groupId : undefined,
        rowId: statusRow?.rowId ?? sessionId,
    };
}

/**
 * How many Sessions the queue would put under "Needs attention", for the Primary Side Bar toggle's badge and the Zen
 * dot: the Sessions with Pending Attention whose Agent is not working or waiting out a usage limit
 * (`sessionActivityGroup`), the same rule that fills the group, so the badge agrees with the rendered heading.
 *
 * Reading a Session does not clear it; only marking it Done, a new turn, or the question being answered elsewhere does.
 * Terminals are indexed only when some Session is pending, so the common idle store pays nothing for them.
 */
export function agentAttentionCount(
    projects: readonly ProjectRecord[],
    sessions: readonly SessionRecord[],
    terminals: readonly TerminalRecord[],
): number {
    const projectIds = new Set(projects.map((project) => project.id));
    const pending = sessions.filter(
        (session) =>
            session.hasPendingAttention &&
            session.archivedAt === undefined &&
            projectIds.has(session.projectId),
    );
    if (pending.length === 0) return 0;
    const terminalsBySession = sessionTerminalIndex(terminals);
    return pending.filter(
        (session) =>
            groupForSession(session, indexedSessionAgentTerminal(session, terminalsBySession)) ===
            'attention',
    ).length;
}

/**
 * The Session `session.focusNextAttention` should move to: the next one in Needs attention, walking the same order the
 * Activity view renders, and wrapping past the current selection so repeated presses cycle the queue instead of
 * sticking on its first row.
 */
export function nextAgentAttentionSessionId(
    groups: readonly AgentActivityGroup[],
    selectedSessionId: string | undefined,
): string | undefined {
    const candidates =
        groups.find((group) => group.id === 'attention')?.rows.map((row) => row.session.id) ?? [];
    if (candidates.length === 0) return undefined;
    const selectedIndex = candidates.indexOf(selectedSessionId ?? '');
    return candidates[(selectedIndex + 1) % candidates.length];
}
