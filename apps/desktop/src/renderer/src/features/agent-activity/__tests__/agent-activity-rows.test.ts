import type { ProjectRecord, SessionRecord, TerminalRecord } from '@caxri/protocol';
import { SESSION_FINISHED_RETENTION_MS } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { sessionAgentTerminal } from '../../session/session-agent-terminal';
import type { AgentActivitySelectionAnchor } from '../agent-activity-rows';
import {
    agentActivityGroups,
    agentActivityHeadingPresentation,
    agentActivityRenameRow,
    agentActivitySelectionAnchor,
    agentAttentionCount,
    isAgentActivityActionable,
    isAgentActivitySelectionAnchorCurrent,
    nextAgentAttentionSessionId,
} from '../agent-activity-rows';

const NOW = 1_000_000_000;

function project(id: string, overrides: Partial<ProjectRecord> = {}): ProjectRecord {
    return { displayTitle: id, id, ...overrides } as ProjectRecord;
}

function session(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
    return {
        attentionEpoch: 0,
        displayTitle: id,
        hasUnread: false,
        id,
        lastActivityState: 'idle',
        lastSessionActivityAt: NOW,
        projectId: 'alpha',
        readAttentionEpoch: 0,
        sidebarOrder: 0,
        ...overrides,
    } as SessionRecord;
}

function terminal(sessionId: string, overrides: Partial<TerminalRecord> = {}): TerminalRecord {
    return {
        id: `terminal-${sessionId}`,
        lastProcessState: 'running',
        sessionId,
        ...overrides,
    } as TerminalRecord;
}

function groupsOf(
    sessions: readonly SessionRecord[],
    terminals: readonly TerminalRecord[] = [],
    selectionAnchor?: AgentActivitySelectionAnchor,
) {
    return agentActivityGroups({
        now: NOW,
        projects: [project('alpha'), project('beta')],
        selectionAnchor,
        sessions,
        terminals,
    });
}

describe('agentActivityGroups', () => {
    it('lists pinned Sessions first, in Pinned order, without repeating idle or finished ones', () => {
        const groups = groupsOf([
            session('idle-pinned', { pinnedAt: 2, pinnedOrder: 1 }),
            session('expired-pinned', {
                lastActivityState: 'completed',
                lastSessionActivityAt: NOW - SESSION_FINISHED_RETENTION_MS - 1,
                pinnedAt: 1,
                pinnedOrder: 0,
            }),
            session('unread-pinned', {
                hasUnread: true,
                lastActivityState: 'completed',
                pinnedAt: 3,
                pinnedOrder: 2,
            }),
            session('idle-unpinned'),
        ]);
        expect(groups.map((group) => [group.id, group.rows.map((row) => row.rowId)])).toEqual([
            ['pinned', ['pinned:expired-pinned', 'pinned:idle-pinned', 'pinned:unread-pinned']],
            ['attention', ['unread-pinned']],
            ['idle', ['idle-unpinned']],
        ]);
        // A pinned copy keeps its state group, so the glyph and tint still describe the Agent.
        expect(groups[0].rows.map((row) => row.groupId)).toEqual(['finished', 'idle', 'attention']);
    });

    it('keeps the attention queue unaware of the Pinned group', () => {
        const groups = groupsOf([
            session('unread-pinned', { hasUnread: true, pinnedAt: 1 }),
            session('idle-pinned', { pinnedAt: 2 }),
        ]);
        expect(nextAgentAttentionSessionId(groups, undefined)).toBe('unread-pinned');
        expect(nextAgentAttentionSessionId(groups, 'unread-pinned')).toBe('unread-pinned');
    });

    it('orders groups attention-first and omits the empty ones', () => {
        const groups = groupsOf([
            session('idle-one'),
            session('running-one', { lastActivityState: 'running' }),
            session('unread-one', { hasUnread: true, lastActivityState: 'completed' }),
            session('failed-one', { lastActivityState: 'failed' }),
        ]);
        expect(groups.map((group) => group.id)).toEqual(['attention', 'working', 'failed', 'idle']);
    });

    it('puts an unread Session under attention even while its Agent is still running', () => {
        const groups = groupsOf([
            session('busy', { hasUnread: true, lastActivityState: 'running' }),
        ]);
        expect(groups.map((group) => group.id)).toEqual(['attention']);
        expect(groups[0].rows[0].session.id).toBe('busy');
    });

    it('leaves the attention group once the Session is read', () => {
        const groups = groupsOf([
            session('read', { hasUnread: false, lastActivityState: 'waiting' }),
        ]);
        expect(groups.map((group) => group.id)).toEqual(['waiting']);
    });

    it('keeps the selected viewed generation in place without keeping it unread', () => {
        const staleAt = NOW - SESSION_FINISHED_RETENTION_MS - 1;
        const unread = session('selected', {
            attentionEpoch: 1,
            hasUnread: true,
            lastActivityState: 'completed',
            lastSessionActivityAt: staleAt,
        });
        const other = session('other', {
            hasUnread: true,
            lastActivityState: 'waiting',
            lastSessionActivityAt: staleAt - 1,
        });
        const anchor = agentActivitySelectionAnchor(groupsOf([unread, other]), unread.id);
        expect(anchor).toBeDefined();

        const viewed = { ...unread, hasUnread: false, readAttentionEpoch: 1 };
        const groups = groupsOf([viewed, other], [], anchor);
        expect(groups[0].rows.map((row) => row.session.id)).toEqual(['selected', 'other']);
        expect(groups[0].rows[0].session.hasUnread).toBe(false);
        expect(agentAttentionCount([project('alpha')], [viewed, other])).toBe(1);
        expect(agentActivityHeadingPresentation(groups[0])).toEqual({
            count: 1,
            label: 'Needs attention',
            summary: '1 unread Session',
        });
        expect(agentActivityHeadingPresentation(groupsOf([viewed], [], anchor)[0])).toEqual({
            count: undefined,
            label: 'Viewing',
            summary: '1 read Session',
        });
        expect(agentAttentionCount([project('alpha')], [viewed])).toBe(0);
        expect(groupsOf([viewed, other])[0].rows.map((row) => row.session.id)).toEqual(['other']);
    });

    it('releases the viewed position for a new Agent activity or attention generation', () => {
        const unread = session('selected', {
            attentionEpoch: 1,
            hasUnread: true,
            lastActivityState: 'waiting',
        });
        const anchor = agentActivitySelectionAnchor(groupsOf([unread]), unread.id);
        expect(anchor).toBeDefined();
        expect(
            groupsOf(
                [{ ...unread, hasUnread: false, lastActivityState: 'completed' }],
                [],
                anchor,
            ).at(0)?.id,
        ).toBe('finished');
        expect(
            groupsOf([{ ...unread, attentionEpoch: 2, hasUnread: false }], [], anchor).at(0)?.id,
        ).toBe('waiting');
    });

    it('keeps a viewed completed Session in place while its Terminal resumes on selection', () => {
        const staleAt = NOW - SESSION_FINISHED_RETENTION_MS - 1;
        const unread = session('selected', {
            attentionEpoch: 1,
            hasUnread: true,
            lastActivityState: 'completed',
            lastSessionActivityAt: staleAt,
        });
        const anchor = agentActivitySelectionAnchor(
            groupsOf([unread], [terminal('selected', { lastProcessState: 'interrupted' })]),
            unread.id,
        );
        expect(anchor).toBeDefined();

        const viewed = { ...unread, hasUnread: false, readAttentionEpoch: 1 };
        expect(
            isAgentActivitySelectionAnchorCurrent(
                anchor!,
                viewed,
                terminal('selected', { lastProcessState: 'running' }),
            ),
        ).toBe(true);
        const groups = groupsOf(
            [viewed],
            [terminal('selected', { lastProcessState: 'running' })],
            anchor,
        );
        expect(groups[0]?.id).toBe('attention');
        expect(groups[0]?.rows[0]?.session.id).toBe(unread.id);
        expect(
            isAgentActivitySelectionAnchorCurrent(
                anchor!,
                viewed,
                terminal('selected', { agentOperation: 'compacting' }),
            ),
        ).toBe(false);
    });

    /**
     * The projection resolves every row's Terminal from a one-pass index instead of scanning all Terminals per Session
     * (issue caxri#1111). The row must still carry the exact Terminal the single lookup picks, or the grouping would
     * describe a different Agent than the glyph beside it.
     */
    it('resolves each row to the Terminal sessionAgentTerminal picks', () => {
        const sessions = [
            session('primary', { primaryAgentTerminalId: 'primary-agent' }),
            session('foreign-primary', { primaryAgentTerminalId: 'primary-agent' }),
            session('first-only'),
            session('no-terminal'),
        ];
        const terminals = [
            terminal('foreign-primary', { id: 'foreign-first' }),
            terminal('primary', { id: 'primary-shell' }),
            terminal('first-only', { id: 'first-only-first' }),
            terminal('primary', { id: 'primary-agent' }),
            terminal('foreign-primary', { id: 'foreign-second' }),
            terminal('first-only', { id: 'first-only-second' }),
        ];
        const rows = groupsOf(sessions, terminals).flatMap((group) => group.rows);
        expect(rows).toHaveLength(sessions.length);
        for (const row of rows)
            expect(row.terminal, row.session.id).toBe(sessionAgentTerminal(row.session, terminals));
        const terminalIdBySession = Object.fromEntries(
            rows.map((row) => [row.session.id, row.terminal?.id]),
        );
        expect(terminalIdBySession).toEqual({
            'first-only': 'first-only-first',
            'foreign-primary': 'foreign-first',
            'no-terminal': undefined,
            'primary': 'primary-agent',
        });
    });

    it('keeps a finished Session listed until its retention window closes', () => {
        const justInside = session('fresh', {
            lastActivityState: 'completed',
            lastSessionActivityAt: NOW - SESSION_FINISHED_RETENTION_MS + 1,
        });
        const exactlyExpired = session('stale', {
            lastActivityState: 'completed',
            lastSessionActivityAt: NOW - SESSION_FINISHED_RETENTION_MS,
        });
        const groups = groupsOf([justInside, exactlyExpired]);
        expect(groups.map((group) => group.id)).toEqual(['finished']);
        expect(groups[0].rows.map((row) => row.session.id)).toEqual(['fresh']);
    });

    it('keeps a failed Session listed regardless of age, because nothing else will clear it', () => {
        const groups = groupsOf([
            session('old-failure', {
                lastActivityState: 'failed',
                lastSessionActivityAt: NOW - 10 * SESSION_FINISHED_RETENTION_MS,
            }),
        ]);
        expect(groups.map((group) => group.id)).toEqual(['failed']);
    });

    it('treats a detached Agent as quiet rather than as work in progress', () => {
        const groups = groupsOf(
            [session('handed-over', { lastActivityState: 'running' })],
            [terminal('handed-over', { lastProcessState: 'detached' })],
        );
        expect(groups.map((group) => group.id)).toEqual(['idle']);
        expect(groups[0].rows[0].status.kind).toBe('detached');
    });

    /**
     * Detaching rewrites the Terminal's process state and leaves `lastActivityState` frozen, so every group below
     * `working` reads a value that stopped being true at the hand-over. A row saying "Detached" under a "Waiting"
     * heading is the visible symptom; a detached `completed` Session silently leaving the list once its retention
     * window expires is the invisible one.
     */
    it.each(['waiting', 'completed'] as const)(
        'does not leave a detached Agent in the %s group its frozen activity would claim',
        (lastActivityState) => {
            const groups = groupsOf(
                [session('handed-over', { lastActivityState })],
                [terminal('handed-over', { lastProcessState: 'detached' })],
            );
            expect(groups.map((group) => group.id)).toEqual(['idle']);
        },
    );

    it('keeps a detached Agent that failed in the failed group, because detaching resolves nothing', () => {
        const groups = groupsOf(
            [session('handed-over', { lastActivityState: 'failed' })],
            [terminal('handed-over', { lastProcessState: 'detached' })],
        );
        expect(groups.map((group) => group.id)).toEqual(['failed']);
    });

    it('reads compaction as working', () => {
        const groups = groupsOf(
            [session('compacting', { lastActivityState: 'completed' })],
            [terminal('compacting', { agentOperation: 'compacting' })],
        );
        expect(groups.map((group) => group.id)).toEqual(['working']);
    });

    it('drops archived Sessions and Sessions whose Project is not listed', () => {
        const groups = groupsOf([
            session('archived', { archivedAt: 1, hasUnread: true }),
            session('orphan', { hasUnread: true, projectId: 'hidden-worktree' }),
        ]);
        expect(groups).toEqual([]);
    });

    it('orders rows inside a group by Session activity recency', () => {
        const groups = groupsOf([
            session('older', { hasUnread: true, lastSessionActivityAt: NOW - 5_000 }),
            session('newer', { hasUnread: true, lastSessionActivityAt: NOW - 1_000 }),
        ]);
        expect(groups[0].rows.map((row) => row.session.id)).toEqual(['newer', 'older']);
    });

    it('names each row with its owning Project', () => {
        const groups = groupsOf([session('one', { hasUnread: true, projectId: 'beta' })]);
        expect(groups[0].rows[0].project.displayTitle).toBe('beta');
    });
});

describe('agentActivityRenameRow', () => {
    it('keeps an unpinned Session on its status row while the Pinned group is open', () => {
        const groups = groupsOf(
            [
                session('pinned', { pinnedAt: 1 }),
                session('waiting', { lastActivityState: 'waiting' }),
            ],
            [terminal('waiting')],
        );
        expect(agentActivityRenameRow(groups, 'waiting', true)).toEqual({
            expandPinned: false,
            rowId: 'waiting',
        });
    });

    it('renames a pinned Session in its Pinned copy only while that copy is rendered', () => {
        const groups = groupsOf(
            [session('pinned', { lastActivityState: 'waiting', pinnedAt: 1 })],
            [terminal('pinned')],
        );
        expect(agentActivityRenameRow(groups, 'pinned', true)).toEqual({
            expandPinned: false,
            rowId: 'pinned:pinned',
        });
        expect(agentActivityRenameRow(groups, 'pinned', false)).toEqual({
            expandPinned: false,
            rowId: 'pinned',
        });
    });

    it('opens a collapsed Pinned group for a Session listed nowhere else', () => {
        const groups = groupsOf([session('pinned', { pinnedAt: 1 })]);
        expect(agentActivityRenameRow(groups, 'pinned', false)).toEqual({
            expandPinned: true,
            rowId: 'pinned:pinned',
        });
    });
});

describe('isAgentActivityActionable', () => {
    it('reserves visual weight for the two groups that ask the user to do something', () => {
        expect(isAgentActivityActionable('attention')).toBe(true);
        expect(isAgentActivityActionable('failed')).toBe(true);
        expect(isAgentActivityActionable('working')).toBe(false);
        expect(isAgentActivityActionable('waiting')).toBe(false);
        expect(isAgentActivityActionable('finished')).toBe(false);
        expect(isAgentActivityActionable('idle')).toBe(false);
    });
});

describe('nextAgentAttentionSessionId', () => {
    it('walks the actionable Sessions in list order and wraps', () => {
        const groups = groupsOf([
            session('unread-a', { hasUnread: true, lastSessionActivityAt: NOW }),
            session('unread-b', { hasUnread: true, lastSessionActivityAt: NOW - 1 }),
            session('broken', { lastActivityState: 'failed' }),
            session('quiet'),
        ]);
        expect(nextAgentAttentionSessionId(groups, undefined)).toBe('unread-a');
        expect(nextAgentAttentionSessionId(groups, 'unread-a')).toBe('unread-b');
        expect(nextAgentAttentionSessionId(groups, 'unread-b')).toBe('broken');
        expect(nextAgentAttentionSessionId(groups, 'broken')).toBe('unread-a');
    });

    it('starts from the top when the selected Session is not in the queue', () => {
        const groups = groupsOf([session('unread', { hasUnread: true }), session('quiet')]);
        expect(nextAgentAttentionSessionId(groups, 'quiet')).toBe('unread');
    });

    it('returns nothing when no Session needs the user', () => {
        const groups = groupsOf([session('quiet')]);
        expect(nextAgentAttentionSessionId(groups, undefined)).toBeUndefined();
    });
});

describe('agentAttentionCount', () => {
    const projects = [project('alpha'), project('beta')];

    it('counts exactly the Sessions the attention group would hold', () => {
        const sessions = [
            session('waiting-on-me', { hasUnread: true }),
            session('also-waiting', { hasUnread: true, projectId: 'beta' }),
            session('quiet'),
        ];
        const groups = agentActivityGroups({ now: NOW, projects, sessions, terminals: [] });

        expect(agentAttentionCount(projects, sessions)).toBe(2);
        expect(groups.find((group) => group.id === 'attention')?.rows).toHaveLength(2);
    });

    /**
     * The badge is drawn while the queue is unmounted, so it has to apply the same two exclusions the queue applies on
     * render; otherwise it advertises rows the user cannot reach by acting on it.
     */
    it('excludes archived Sessions and Sessions outside the listed Projects', () => {
        const sessions = [
            session('archived', { archivedAt: NOW, hasUnread: true }),
            session('hidden-worktree', { hasUnread: true, projectId: 'worktree' }),
            session('counted', { hasUnread: true }),
        ];

        expect(agentAttentionCount(projects, sessions)).toBe(1);
    });

    it('is zero with nothing unread', () => {
        expect(agentAttentionCount(projects, [session('quiet')])).toBe(0);
    });
});
