import type {
    ProjectRecord,
    SessionActivityGroupId,
    SessionRecord,
    TerminalRecord,
} from '@caxri/protocol';
import {
    compareSessionActivityGroupRows,
    compareSessionPinnedOrder,
    isPinnedSession,
    PINNED_DUPLICATE_SESSION_ACTIVITY_GROUPS,
    SESSION_ACTIVITY_GROUP_ORDER,
    sessionActivityGroup,
} from '@caxri/protocol';

import type { Translate, TranslationKey } from '../../i18n';
import { translate } from '../../i18n';
import type { SessionActivityPresentation } from '../primary-sidebar/session-activity';
import { sessionActivityPresentation } from '../primary-sidebar/session-activity';
import type { SessionStatus } from '../primary-sidebar/session-status';
import { sessionStatus } from '../primary-sidebar/session-status';
import {
    indexedSessionAgentTerminal,
    sessionTerminalIndex,
} from '../session/session-agent-terminal';

/**
 * The state-derived groups. A row always carries one of these, including a row listed under `pinned`, because the row's
 * glyph and tint are decided by the Agent's state rather than by where the row happens to sit.
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
     * The same projection the row's glyph uses, resolved here because the group a row lands in has to be decided by it
     * too. `SessionStatusIndicator` resolves it again from the same Session and Terminal, so the two always agree; this
     * copy exists so the grouping and the row's state phrase never drift from the glyph beside them.
     */
    status: SessionStatus;
    statusPresentation: SessionActivityPresentation;
    terminal: TerminalRecord | undefined;
}

export interface AgentActivityGroup {
    id: AgentActivityGroupId;
    rows: AgentActivityRow[];
}

/**
 * A viewed unread generation may keep its row in place until the user leaves that Session.
 */
export interface AgentActivitySelectionAnchor {
    agentOperation: TerminalRecord['agentOperation'];
    attentionEpoch: number;
    lastActivityState: SessionRecord['lastActivityState'];
    lastSessionActivityAt: number;
    sessionId: string;
}

export function agentActivitySelectionAnchor(
    groups: readonly AgentActivityGroup[],
    selectedSessionId: string | undefined,
): AgentActivitySelectionAnchor | undefined {
    const row = groups
        .find((group) => group.id === 'attention')
        ?.rows.find((candidate) => candidate.session.id === selectedSessionId);
    if (!row) return undefined;
    return {
        agentOperation: row.terminal?.agentOperation,
        attentionEpoch: row.session.attentionEpoch,
        lastActivityState: row.session.lastActivityState,
        lastSessionActivityAt: row.session.lastSessionActivityAt,
        sessionId: row.session.id,
    };
}

export function isAgentActivitySelectionAnchorCurrent(
    anchor: AgentActivitySelectionAnchor,
    session: SessionRecord | undefined,
    terminal: TerminalRecord | undefined,
): boolean {
    return Boolean(
        session &&
        session.id === anchor.sessionId &&
        session.attentionEpoch === anchor.attentionEpoch &&
        session.lastActivityState === anchor.lastActivityState &&
        session.lastSessionActivityAt === anchor.lastSessionActivityAt &&
        terminal?.agentOperation === anchor.agentOperation,
    );
}

function isViewedSelection(
    session: SessionRecord,
    terminal: TerminalRecord | undefined,
    anchor: AgentActivitySelectionAnchor | undefined,
): boolean {
    return Boolean(
        anchor &&
        !session.hasUnread &&
        isAgentActivitySelectionAnchorCurrent(anchor, session, terminal),
    );
}

const GROUP_LABEL_KEYS: Record<AgentActivityGroupId, TranslationKey> = {
    pinned: 'agentActivity.group.pinned',
    attention: 'agentActivity.group.attention',
    failed: 'agentActivity.group.failed',
    finished: 'agentActivity.group.finished',
    idle: 'agentActivity.group.idle',
    waiting: 'agentActivity.group.waiting',
    working: 'agentActivity.group.working',
};

/**
 * Heading words for one group. Components pass their `useTranslation()` `t` so a language change re-renders the
 * heading; the `translate` default serves unit tests and other non-React callers.
 */
export function agentActivityHeadingPresentation(
    group: AgentActivityGroup,
    t: Translate = translate,
): {
    count: number | undefined;
    label: string;
    summary: string;
} {
    const label = t(GROUP_LABEL_KEYS[group.id]);
    if (group.id === 'attention') {
        const unreadCount = group.rows.filter((row) => row.session.hasUnread).length;
        if (unreadCount === 0) {
            const viewedCount = group.rows.length;
            return {
                count: undefined,
                label: t('agentActivity.group.viewing'),
                summary: t(
                    viewedCount === 1
                        ? 'agentActivity.heading.readSessionsOne'
                        : 'agentActivity.heading.readSessionsOther',
                    { count: viewedCount },
                ),
            };
        }
        return {
            count: unreadCount,
            label,
            summary: t(
                unreadCount === 1
                    ? 'agentActivity.heading.unreadSessionsOne'
                    : 'agentActivity.heading.unreadSessionsOther',
                { count: unreadCount },
            ),
        };
    }
    const count = group.rows.length;
    return {
        count,
        label,
        summary: t(
            count === 1
                ? 'agentActivity.heading.sessionsOne'
                : 'agentActivity.heading.sessionsOther',
            { count },
        ),
    };
}

/**
 * The two groups whose rows ask the user to do something. They are the only ones that earn a tinted callout; every
 * other state stays quiet chrome, so visual weight in this list always means "this one wants you" and never has to be
 * decoded against a color legend.
 */
export function isAgentActivityActionable(groupId: AgentActivityGroupId): boolean {
    return groupId === 'attention' || groupId === 'failed';
}

/**
 * The shared rule (`sessionActivityGroup`) with Desktop's own inputs: the status projection, which folds compaction
 * into running, and the viewed selection, which keeps a just-read row under attention until the user leaves it.
 */
function groupForSession(
    session: SessionRecord,
    status: SessionStatus,
    now: number,
    isViewedSelection: boolean,
): AgentActivityStatusGroupId | undefined {
    if (isViewedSelection) return 'attention';
    return sessionActivityGroup(
        {
            hasUnread: status.kind === 'attention',
            isDetached: status.kind === 'detached',
            isRunning: status.kind === 'running',
            lastActivityState: session.lastActivityState,
            lastSessionActivityAt: session.lastSessionActivityAt,
        },
        now,
    );
}

/**
 * Projects every Project's active Sessions into one flat, attention-first list.
 *
 * Archived Sessions are excluded, and a Session whose Project is not in `projects` is dropped: the PrimarySidebar hides
 * auto-registered worktree Projects, and a row naming a Project the user never added would be unreachable from here.
 * Rows inside a status group keep Session activity recency, so the most recent event in a group is always its first
 * row. Pinned Sessions also get a leading `pinned` group (see `PINNED_DUPLICATE_SESSION_ACTIVITY_GROUPS` for which ones
 * stay in their status group too), and a pinned Session is never dropped by the finished retention window.
 *
 * Terminals are grouped by Session once per call, so one projection is linear in Sessions plus Terminals. It has two
 * callers and neither runs while the queue is off screen: `AgentActivityView` exists only while the Primary Side Bar
 * shows Activity (`PrimarySidebar` unmounts the body it hides, and `App` unmounts a collapsed side bar), and
 * `session.focusNextAttention` computes its own copy from the store on demand, so the shortcut still works when the
 * queue was never opened (issue caxri#1111).
 */
export function agentActivityGroups({
    now,
    projects,
    selectionAnchor,
    sessions,
    terminals,
}: {
    now: number;
    projects: readonly ProjectRecord[];
    selectionAnchor?: AgentActivitySelectionAnchor;
    sessions: readonly SessionRecord[];
    terminals: readonly TerminalRecord[];
}): AgentActivityGroup[] {
    const projectsById = new Map(projects.map((project) => [project.id, project]));
    const terminalsBySession = sessionTerminalIndex(terminals);
    const rowsByGroup = new Map<AgentActivityStatusGroupId, AgentActivityRow[]>();
    const pinnedRows: AgentActivityRow[] = [];
    for (const session of sessions) {
        if (session.archivedAt !== undefined) continue;
        const project = projectsById.get(session.projectId);
        if (project === undefined) continue;
        const terminal = indexedSessionAgentTerminal(session, terminalsBySession);
        const status = sessionStatus(session, terminal);
        const groupId = groupForSession(
            session,
            status,
            now,
            isViewedSelection(session, terminal, selectionAnchor),
        );
        const pinned = isPinnedSession(session);
        if (!groupId && !pinned) continue;
        const row: AgentActivityRow = {
            /**
             * A pinned Session past the finished retention window has no status group but stays listed under `pinned`;
             * it still describes a finished turn, so its glyph reads as one.
             */
            groupId: groupId ?? 'finished',
            project,
            rowId: session.id,
            session,
            status,
            statusPresentation: sessionActivityPresentation(
                session.lastActivityState,
                terminal?.agentOperation,
            ),
            terminal,
        };
        if (pinned) pinnedRows.push({ ...row, rowId: agentActivityPinnedRowId(session.id) });
        if (!groupId || (pinned && !PINNED_DUPLICATE_SESSION_ACTIVITY_GROUPS.has(groupId)))
            continue;
        const existing = rowsByGroup.get(groupId);
        if (existing) existing.push(row);
        else rowsByGroup.set(groupId, [row]);
    }
    const statusGroups = SESSION_ACTIVITY_GROUP_ORDER.flatMap((id) => {
        const rows = rowsByGroup.get(id);
        if (!rows || rows.length === 0) return [];
        return [
            {
                id,
                rows: rows.toSorted((left, right) =>
                    compareSessionActivityGroupRows(left.session, right.session),
                ),
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
export function agentActivityPinnedRowId(sessionId: string): string {
    return `pinned:${sessionId}`;
}

/**
 * How many Sessions the queue would put under "Needs attention", for the Primary Side Bar toggle's badge.
 *
 * Counted straight from `hasUnread` rather than by projecting the whole queue: `sessionStatus` derives `attention` from
 * exactly that flag, so this agrees with the rendered group by construction while the badge, which is on screen whether
 * or not the queue is, stays independent of Terminal records and the retention clock.
 *
 * "Failed" is deliberately left out even though it is the other actionable group. A failure you have already read stays
 * failed until you act on it, and a badge that cannot be cleared by looking stops being a signal.
 */
export function agentAttentionCount(
    projects: readonly ProjectRecord[],
    sessions: readonly SessionRecord[],
): number {
    const projectIds = new Set(projects.map((project) => project.id));
    return sessions.filter(
        (session) =>
            session.hasUnread &&
            session.archivedAt === undefined &&
            projectIds.has(session.projectId),
    ).length;
}

/**
 * The Session `session.focusNextAttention` should move to: the next one that needs the user, walking the same order the
 * Activity view renders, and wrapping past the current selection so repeated presses cycle the queue instead of
 * sticking on its first row.
 */
export function nextAgentAttentionSessionId(
    groups: readonly AgentActivityGroup[],
    selectedSessionId: string | undefined,
): string | undefined {
    const candidates = groups
        .filter((group) => isAgentActivityActionable(group.id))
        .flatMap((group) => group.rows.map((row) => row.session.id));
    if (candidates.length === 0) return undefined;
    const selectedIndex = candidates.indexOf(selectedSessionId ?? '');
    return candidates[(selectedIndex + 1) % candidates.length];
}
