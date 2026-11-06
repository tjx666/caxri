import type { ProjectRecord, SessionRecord, TerminalRecord } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { translate } from '../../../i18n';
import { sessionAgentTerminal } from '../../session/session-agent-terminal';
import {
    agentActivityGroups,
    agentActivityHeadingPresentation,
    agentActivityRenameRow,
    agentAttentionCount,
    nextAgentAttentionSessionId,
} from '../agent-activity-rows';

const NOW = 1_000_000_000;

function project(id: string, overrides: Partial<ProjectRecord> = {}): ProjectRecord {
    return { title: id, id, ...overrides } as ProjectRecord;
}

function session(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
    return {
        attentionGeneration: 0,
        title: id,
        hasPendingAttention: false,
        hasUnread: false,
        id,
        agentActivityState: 'idle',
        sessionActivityAt: NOW,
        projectId: 'alpha',
        acknowledgedAttentionGeneration: 0,
        resolvedAttentionGeneration: 0,
        sidebarOrder: 0,
        ...overrides,
    } as SessionRecord;
}

/**
 * A Session whose finished turn the user has not marked Done.
 */
function pending(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
    return session(id, {
        agentActivityState: 'completed',
        attentionGeneration: 1,
        hasPendingAttention: true,
        hasUnread: true,
        lastAttentionKind: 'completed',
        ...overrides,
    });
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
    mergedPullRequestSessionIds?: ReadonlySet<string>,
) {
    return agentActivityGroups({
        mergedPullRequestSessionIds,
        projects: [project('alpha'), project('beta')],
        sessions,
        terminals,
    });
}

function idsOf(group: { rows: ReadonlyArray<{ session: { id: string } }> } | undefined): string[] {
    return group?.rows.map((row) => row.session.id) ?? [];
}

describe('agentActivityGroups', () => {
    it('orders the three status groups and omits the empty ones', () => {
        const groups = groupsOf([
            session('idle-one'),
            session('running-one', { agentActivityState: 'running' }),
            pending('pending-one'),
        ]);
        expect(groups.map((group) => group.id)).toEqual(['attention', 'working', 'idle']);
        expect(groupsOf([session('idle-one')]).map((group) => group.id)).toEqual(['idle']);
    });

    it('keeps a read Session in Needs attention until it is marked Done', () => {
        const groups = groupsOf([
            pending('read-but-pending', { hasUnread: false }),
            session('done', { agentActivityState: 'completed' }),
        ]);
        expect(idsOf(groups[0])).toEqual(['read-but-pending']);
        expect(groups.map((group) => group.id)).toEqual(['attention', 'idle']);
    });

    it('files a running Agent under Working even when unread attention is pending', () => {
        const groups = groupsOf([pending('busy', { agentActivityState: 'running' })]);
        expect(groups.map((group) => group.id)).toEqual(['working']);
    });

    it('reads compaction as working', () => {
        const groups = groupsOf(
            [pending('compacting')],
            [terminal('compacting', { agentOperation: 'compacting' })],
        );
        expect(groups.map((group) => group.id)).toEqual(['working']);
    });

    it('files a Chat waiting for a usage limit as idle, even with a pending failure', () => {
        const groups = groupsOf(
            [pending('waiting-limit', { agentActivityState: 'failed' })],
            [terminal('waiting-limit', { usageLimitWaitAt: NOW + 3_600_000 })],
        );
        expect(groups.map((group) => group.id)).toEqual(['idle']);
    });

    it('keeps the pending result of a detached Agent in Needs attention but not its frozen running state', () => {
        const detached = terminal('handed-over', { lastProcessState: 'detached' });
        expect(groupsOf([pending('handed-over')], [detached]).map((group) => group.id)).toEqual([
            'attention',
        ]);
        expect(
            groupsOf([session('handed-over', { agentActivityState: 'running' })], [detached]).map(
                (group) => group.id,
            ),
        ).toEqual(['idle']);
    });

    it('lists pinned Sessions first, in Pinned order, repeating only attention and working ones', () => {
        const groups = groupsOf([
            session('idle-pinned', { pinnedAt: 2, pinnedOrder: 1 }),
            pending('pending-pinned', { pinnedAt: 3, pinnedOrder: 2 }),
            session('running-pinned', {
                agentActivityState: 'running',
                pinnedAt: 1,
                pinnedOrder: 0,
            }),
            session('idle-unpinned'),
        ]);
        expect(groups.map((group) => [group.id, group.rows.map((row) => row.rowId)])).toEqual([
            ['pinned', ['pinned:running-pinned', 'pinned:idle-pinned', 'pinned:pending-pinned']],
            ['attention', ['pending-pinned']],
            ['working', ['running-pinned']],
            ['idle', ['idle-unpinned']],
        ]);
        // A pinned copy keeps the Agent's real group.
        expect(groups[0].rows.map((row) => row.groupId)).toEqual(['working', 'idle', 'attention']);
    });

    it('ranks a question or failure above a merged pull request above a plain result', () => {
        const groups = groupsOf(
            [
                pending('result', { sessionActivityAt: NOW }),
                pending('merged', { sessionActivityAt: NOW - 1_000 }),
                pending('failed', { lastAttentionKind: 'failed', sessionActivityAt: NOW - 2_000 }),
                pending('asking', {
                    lastAttentionKind: 'waiting',
                    sessionActivityAt: NOW - 3_000,
                }),
            ],
            [],
            new Set(['merged']),
        );
        expect(idsOf(groups[0])).toEqual(['failed', 'asking', 'merged', 'result']);
    });

    it('lists background waits first in Working, then by recency', () => {
        const groups = groupsOf(
            [
                session('fresh', { agentActivityState: 'running', sessionActivityAt: NOW }),
                session('watching', {
                    agentActivityState: 'running',
                    sessionActivityAt: NOW - 5_000,
                }),
                session('older', { agentActivityState: 'running', sessionActivityAt: NOW - 9_000 }),
            ],
            [terminal('watching', { agentOperation: 'background' })],
        );
        expect(idsOf(groups[0])).toEqual(['watching', 'fresh', 'older']);
        expect(groups[0].rows.map((row) => row.isBackgroundWait)).toEqual([true, false, false]);
    });

    it('puts a Session just marked Done at the top of Idle without moving its work clock', () => {
        const groups = groupsOf([
            session('newer-work', { sessionActivityAt: NOW }),
            session('just-done', {
                attentionResolvedAt: NOW + 5_000,
                sessionActivityAt: NOW - 60_000,
            }),
        ]);
        expect(idsOf(groups[0])).toEqual(['just-done', 'newer-work']);
    });

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
    });

    it('drops archived Sessions and Sessions whose Project is not listed', () => {
        const groups = groupsOf([
            pending('archived', { archivedAt: 1 }),
            pending('orphan', { projectId: 'hidden-worktree' }),
        ]);
        expect(groups).toEqual([]);
    });

    it('names each row with its owning Project', () => {
        const groups = groupsOf([pending('one', { projectId: 'beta' })]);
        expect(groups[0].rows[0].project.title).toBe('beta');
    });
});

describe('agentActivityHeadingPresentation', () => {
    it('labels the groups and counts every row', () => {
        const groups = groupsOf([pending('a'), pending('b'), session('c')]);
        expect(agentActivityHeadingPresentation(groups[0], translate)).toEqual({
            count: 2,
            label: 'Needs attention',
            summary: '2 Sessions',
        });
        expect(agentActivityHeadingPresentation(groups[1], translate)).toMatchObject({
            count: 1,
            label: 'Idle',
            summary: '1 Session',
        });
    });
});

describe('agentActivityRenameRow', () => {
    const OPEN = new Set<never>();
    const PINNED_COLLAPSED = new Set(['pinned'] as const);

    it('keeps an unpinned Session on its status row while the Pinned group is open', () => {
        const groups = groupsOf([session('pinned', { pinnedAt: 1 }), pending('waiting')]);
        expect(agentActivityRenameRow(groups, 'waiting', OPEN)).toEqual({
            expandGroupId: undefined,
            rowId: 'waiting',
        });
    });

    it('renames a pinned Session in its Pinned copy only while that copy is rendered', () => {
        const groups = groupsOf([pending('pinned', { pinnedAt: 1 })]);
        expect(agentActivityRenameRow(groups, 'pinned', OPEN)).toEqual({
            expandGroupId: undefined,
            rowId: 'pinned:pinned',
        });
        expect(agentActivityRenameRow(groups, 'pinned', PINNED_COLLAPSED)).toEqual({
            expandGroupId: undefined,
            rowId: 'pinned',
        });
    });

    it('opens a collapsed Pinned group for a Session listed nowhere else', () => {
        const groups = groupsOf([session('pinned', { pinnedAt: 1 })]);
        expect(agentActivityRenameRow(groups, 'pinned', PINNED_COLLAPSED)).toEqual({
            expandGroupId: 'pinned',
            rowId: 'pinned:pinned',
        });
    });

    it('opens the collapsed status group that holds the row', () => {
        const groups = groupsOf([pending('waiting')]);
        expect(agentActivityRenameRow(groups, 'waiting', new Set(['attention'] as const))).toEqual({
            expandGroupId: 'attention',
            rowId: 'waiting',
        });
    });
});

describe('nextAgentAttentionSessionId', () => {
    it('walks the Needs attention rows in list order and wraps', () => {
        const groups = groupsOf([
            pending('result-a', { sessionActivityAt: NOW }),
            pending('result-b', { sessionActivityAt: NOW - 1 }),
            pending('broken', { lastAttentionKind: 'failed' }),
            session('quiet'),
            session('running', { agentActivityState: 'running' }),
        ]);
        expect(nextAgentAttentionSessionId(groups, undefined)).toBe('broken');
        expect(nextAgentAttentionSessionId(groups, 'broken')).toBe('result-a');
        expect(nextAgentAttentionSessionId(groups, 'result-a')).toBe('result-b');
        expect(nextAgentAttentionSessionId(groups, 'result-b')).toBe('broken');
    });

    it('keeps the queue unaware of the Pinned group and of working or idle Sessions', () => {
        const groups = groupsOf([
            pending('pending-pinned', { pinnedAt: 1 }),
            session('idle-pinned', { pinnedAt: 2 }),
            session('running', { agentActivityState: 'running' }),
        ]);
        expect(nextAgentAttentionSessionId(groups, undefined)).toBe('pending-pinned');
        expect(nextAgentAttentionSessionId(groups, 'pending-pinned')).toBe('pending-pinned');
    });

    it('starts from the top when the selected Session is not in the queue', () => {
        const groups = groupsOf([pending('pending'), session('quiet')]);
        expect(nextAgentAttentionSessionId(groups, 'quiet')).toBe('pending');
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
            pending('waiting-on-me'),
            pending('read-but-pending', { hasUnread: false }),
            pending('also-waiting', { projectId: 'beta' }),
            pending('still-running', { agentActivityState: 'running' }),
            session('quiet'),
        ];
        const groups = agentActivityGroups({ projects, sessions, terminals: [] });

        expect(agentAttentionCount(projects, sessions, [])).toBe(3);
        expect(groups.find((group) => group.id === 'attention')?.rows).toHaveLength(3);
    });

    it('does not count a Session whose Agent is compacting or waiting out a usage limit', () => {
        const sessions = [pending('compacting'), pending('limited'), pending('plain')];
        const terminals = [
            terminal('compacting', { agentOperation: 'compacting' }),
            terminal('limited', { usageLimitWaitAt: NOW }),
        ];

        expect(agentAttentionCount(projects, sessions, terminals)).toBe(1);
    });

    /**
     * The badge is drawn while the queue is unmounted, so it has to apply the same two exclusions the queue applies on
     * render; otherwise it advertises rows the user cannot reach by acting on it.
     */
    it('excludes archived Sessions and Sessions outside the listed Projects', () => {
        const sessions = [
            pending('archived', { archivedAt: NOW }),
            pending('hidden-worktree', { projectId: 'worktree' }),
            pending('counted'),
        ];

        expect(agentAttentionCount(projects, sessions, [])).toBe(1);
    });

    it('is zero with nothing pending', () => {
        expect(agentAttentionCount(projects, [session('quiet')], [])).toBe(0);
    });
});
