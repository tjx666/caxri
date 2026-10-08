import type { ProjectRecord, SessionRecord, TerminalRecord } from '@caxri/protocol';

import type { SessionActivityPresentation } from '../primary-sidebar/session-activity';
import { sessionActivityPresentation } from '../primary-sidebar/session-activity';
import type { SessionStatus } from '../primary-sidebar/session-status';
import { sessionStatus } from '../primary-sidebar/session-status';
import {
    indexedSessionAgentTerminal,
    sessionTerminalIndex,
} from '../session/session-agent-terminal';
import { isWithinFinishedRetention } from './agent-activity-retention';

export type AgentActivityGroupId =
    'attention' | 'working' | 'waiting' | 'failed' | 'finished' | 'idle';

export interface AgentActivityRow {
    groupId: AgentActivityGroupId;
    /**
     * Owning Project, named on the row's second line because the list is flat: without it a row cannot say which
     * repository it belongs to. The whole record rather than its name, because the row's hover card and context menu
     * act on the Project too.
     */
    project: ProjectRecord;
    session: SessionRecord;
    /**
     * The same projection the row's glyph uses, resolved here because the group a row lands in has to be decided by it
     * too. `SessionAgentStatusIcon` resolves it again from the same Session and Terminal, so the two always agree; this
     * copy exists so the grouping and the row's state phrase never drift from the glyph beside them.
     */
    status: SessionStatus;
    statusPresentation: SessionActivityPresentation;
    terminal: TerminalRecord | undefined;
}

export interface AgentActivityGroup {
    id: AgentActivityGroupId;
    label: string;
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

/**
 * Attention first, then live work, then everything that is merely history.
 *
 * `attention` deliberately outranks `working`: Caxri's unread flag means "something happened that you have not looked
 * at", which is a property of the user's queue rather than of the Agent, so it belongs above any turn still in
 * progress, including the Session's own, since a Session can be both unread and running. herdr and Kero rank their
 * rollups the same way; Orca and T3 Code put running work first because their lists describe live work rather than a
 * to-do queue.
 */
const GROUP_ORDER: readonly AgentActivityGroupId[] = [
    'attention',
    'working',
    'waiting',
    'failed',
    'finished',
    'idle',
];

const GROUP_LABELS: Record<AgentActivityGroupId, string> = {
    attention: 'Needs attention',
    failed: 'Failed',
    finished: 'Recently finished',
    idle: 'Idle',
    waiting: 'Waiting',
    working: 'Working',
};

export function agentActivityHeadingPresentation(group: AgentActivityGroup): {
    count: number | undefined;
    label: string;
    summary: string;
} {
    if (group.id === 'attention') {
        const unreadCount = group.rows.filter((row) => row.session.hasUnread).length;
        if (unreadCount === 0) {
            const viewedCount = group.rows.length;
            return {
                count: undefined,
                label: 'Viewing',
                summary: `${viewedCount} read ${viewedCount === 1 ? 'Session' : 'Sessions'}`,
            };
        }
        return {
            count: unreadCount,
            label: group.label,
            summary: `${unreadCount} unread ${unreadCount === 1 ? 'Session' : 'Sessions'}`,
        };
    }
    const count = group.rows.length;
    return {
        count,
        label: group.label,
        summary: `${count} ${count === 1 ? 'Session' : 'Sessions'}`,
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

function groupForSession(
    session: SessionRecord,
    status: SessionStatus,
    now: number,
    isViewedSelection: boolean,
): AgentActivityGroupId | undefined {
    if (status.kind === 'attention') return 'attention';
    if (isViewedSelection) return 'attention';
    /**
     * Failure survives the hand-over. Detaching stops the Terminal so another client can resume it; it does not resolve
     * anything, and nothing else will ever clear a failed Session, so a detached failure stays in `failed` rather than
     * quietly joining `idle` below.
     */
    if (session.lastActivityState === 'failed') return 'failed';
    // `running` covers compaction too: `sessionStatus` already folds that subphase in.
    if (status.kind === 'running') return 'working';
    /**
     * Everything below reads `lastActivityState`, which a detached Agent keeps frozen at whatever the last probe
     * recorded: `suspendTerminal` only rewrites the Terminal's process state. Without this guard a Session detached
     * mid-turn would keep sitting under "Waiting" (or age out of "Recently finished" and vanish) while its own row
     * reads "Detached". It is not waiting on anybody: it was handed to another client on purpose.
     */
    if (status.kind === 'detached') return 'idle';
    if (session.lastActivityState === 'waiting') return 'waiting';
    if (session.lastActivityState === 'completed')
        return isWithinFinishedRetention(session, now) ? 'finished' : undefined;
    // `idle` and `unknown` land here: neither is asking the user for anything.
    return 'idle';
}

/**
 * Projects every Project's active Sessions into one flat, attention-first list.
 *
 * Archived Sessions are excluded, and a Session whose Project is not in `projects` is dropped: the PrimarySidebar hides
 * auto-registered worktree Projects, and a row naming a Project the user never added would be unreachable from here.
 * Rows inside a group keep Session activity recency, so the most recent event in a group is always its first row.
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
    const rowsByGroup = new Map<AgentActivityGroupId, AgentActivityRow[]>();
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
        if (!groupId) continue;
        const row: AgentActivityRow = {
            groupId,
            project,
            session,
            status,
            statusPresentation: sessionActivityPresentation(
                session.lastActivityState,
                terminal?.agentOperation,
            ),
            terminal,
        };
        const existing = rowsByGroup.get(groupId);
        if (existing) existing.push(row);
        else rowsByGroup.set(groupId, [row]);
    }
    return GROUP_ORDER.flatMap((id) => {
        const rows = rowsByGroup.get(id);
        if (!rows || rows.length === 0) return [];
        return [
            {
                id,
                label: GROUP_LABELS[id],
                rows: rows.toSorted(
                    (left, right) =>
                        right.session.lastSessionActivityAt - left.session.lastSessionActivityAt ||
                        (left.session.id < right.session.id ? -1 : 1),
                ),
            },
        ];
    });
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
