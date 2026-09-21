import type { ProjectRecord, SessionRecord, TerminalRecord } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { AGENT_ACTIVITY_FINISHED_RETENTION_MS } from '../agent-activity-retention';
import {
    agentActivityGroups,
    isAgentActivityActionable,
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

function groupsOf(sessions: readonly SessionRecord[], terminals: readonly TerminalRecord[] = []) {
    return agentActivityGroups({
        now: NOW,
        projects: [project('alpha'), project('beta')],
        sessions,
        terminals,
    });
}

describe('agentActivityGroups', () => {
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

    it('keeps a finished Session listed until its retention window closes', () => {
        const justInside = session('fresh', {
            lastActivityState: 'completed',
            lastSessionActivityAt: NOW - AGENT_ACTIVITY_FINISHED_RETENTION_MS + 1,
        });
        const exactlyExpired = session('stale', {
            lastActivityState: 'completed',
            lastSessionActivityAt: NOW - AGENT_ACTIVITY_FINISHED_RETENTION_MS,
        });
        const groups = groupsOf([justInside, exactlyExpired]);
        expect(groups.map((group) => group.id)).toEqual(['finished']);
        expect(groups[0].rows.map((row) => row.session.id)).toEqual(['fresh']);
    });

    it('keeps a failed Session listed regardless of age, because nothing else will clear it', () => {
        const groups = groupsOf([
            session('old-failure', {
                lastActivityState: 'failed',
                lastSessionActivityAt: NOW - 10 * AGENT_ACTIVITY_FINISHED_RETENTION_MS,
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
        expect(groups[0].rows[0].projectName).toBe('beta');
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
