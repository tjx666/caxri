import type {
    AgentDelegationReceipt,
    ProjectRecord,
    SessionRecord,
    TerminalRecord,
} from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { BOT_FINISHED_RETENTION_MS, botBoard, botBoardGroup } from '../board';

const NOW = 10 * BOT_FINISHED_RETENTION_MS;

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
    return {
        id: 'session-1',
        projectId: 'project-1',
        workbenchProjectId: 'project-1',
        rootPath: '/workspace/project',
        createdAt: 1,
        lastOpenedAt: 1,
        lastSessionActivityAt: NOW - 1_000,
        sidebarOrder: 0,
        lastSessionActivityReason: 'created',
        lastActivityState: 'idle',
        attentionEpoch: 0,
        readAttentionEpoch: 0,
        hasUnread: false,
        displayTitle: 'Fix the parser',
        titleMode: 'automatic',
        ...overrides,
    };
}

function terminal(overrides: Partial<TerminalRecord> = {}): TerminalRecord {
    return {
        id: 'terminal-1',
        sessionId: 'session-1',
        kind: 'codex',
        cwd: '/workspace/project',
        title: 'Codex',
        orderIndex: 0,
        lastProcessState: 'running',
        lastAgentProcessState: 'running',
        createdAt: 1,
        updatedAt: 1,
        ...overrides,
    };
}

function task(overrides: Partial<AgentDelegationReceipt>): AgentDelegationReceipt {
    return {
        delegationId: 'delegation-1',
        projectId: 'project-1',
        sessionId: 'session-2',
        callerTerminalId: 'bot-terminal',
        provider: 'codex',
        status: 'running',
        revision: 1,
        createdAt: 1,
        updatedAt: 2,
        ...overrides,
    };
}

const project = {
    id: 'project-1',
    rootPath: '/workspace/project',
    displayTitle: 'project',
    orderIndex: 0,
    createdAt: 1,
    lastOpenedAt: 1,
} satisfies ProjectRecord;

describe('Caxri Bot board grouping', () => {
    it.each([
        [{ hasUnread: true, lastActivityState: 'running' }, 'running', 'attention'],
        [{ lastActivityState: 'failed' }, 'dead', 'failed'],
        [{ lastActivityState: 'running' }, 'running', 'working'],
        [{ lastActivityState: 'running' }, 'dead', 'idle'],
        [{ lastActivityState: 'waiting' }, 'running', 'waiting'],
        [{ lastActivityState: 'completed' }, 'running', 'finished'],
        [
            {
                lastActivityState: 'completed',
                lastSessionActivityAt: NOW - BOT_FINISHED_RETENTION_MS,
            },
            'running',
            'idle',
        ],
    ] as const)('groups %o with a %s Terminal as %s', (overrides, processState, group) => {
        expect(
            botBoardGroup(session(overrides), terminal({ lastProcessState: processState }), NOW),
        ).toBe(group);
    });

    it.each([
        [
            'an Agent that exited inside a live Shell',
            { lastAgentProcessState: 'stopped' },
            'idle',
            'stopped',
        ],
        [
            'an Agent whose state was never recorded',
            { lastAgentProcessState: undefined },
            'idle',
            'stopped',
        ],
        [
            'a starting Shell',
            { lastProcessState: 'starting', lastAgentProcessState: undefined },
            'working',
            'starting',
        ],
        [
            'a plain Shell',
            { kind: 'shell', lastAgentProcessState: undefined },
            'working',
            'running',
        ],
    ] as const)(
        'groups a running turn in %s by the process it describes',
        (_, overrides, group, processState) => {
            const board = botBoard({
                botTasks: [],
                botSessionIds: new Set(),
                now: NOW,
                projects: [project],
                pullRequests: { pullRequests: {}, refreshedAt: 0 },
                sessions: [session({ lastActivityState: 'running' })],
                tasks: [],
                terminals: [terminal(overrides)],
            });

            expect(board.rows[0]).toMatchObject({ group, agent: { processState } });
        },
    );

    it('orders rows by group, then by recency, and drops archived or foreign Sessions', () => {
        const board = botBoard({
            botTasks: [],
            botSessionIds: new Set(['session-2']),
            now: NOW,
            projects: [project, { ...project, id: 'worktree', ownerProjectId: 'project-1' }],
            pullRequests: {
                pullRequests: {
                    'session-2': {
                        number: 7,
                        title: 'Fix',
                        url: 'https://example.com/pull/7',
                        state: 'open',
                        source: 'branch',
                    },
                },
                refreshedAt: 42,
            },
            sessions: [
                session({ id: 'session-1', lastSessionActivityAt: NOW - 2_000 }),
                session({ id: 'session-2', lastSessionActivityAt: NOW - 1_000 }),
                session({ id: 'session-3', hasUnread: true }),
                session({ id: 'session-4', archivedAt: 1 }),
                session({ id: 'session-5', projectId: 'worktree' }),
            ],
            tasks: [
                task({ delegationId: 'older', status: 'completed', createdAt: 1, updatedAt: 5 }),
                task({
                    delegationId: 'latest',
                    status: 'failed',
                    failure: 'startup_not_ready',
                    createdAt: 2,
                }),
            ],
            terminals: [terminal({ sessionId: 'session-2', id: 'terminal-2' })],
        });

        expect(board.projects.map(({ id }) => id)).toEqual(['project-1']);
        expect(board.pullRequestsRefreshedAt).toBe(42);
        expect(board.rows.map(({ sessionId, group }) => [sessionId, group])).toEqual([
            ['session-3', 'attention'],
            ['session-2', 'failed'],
            ['session-1', 'idle'],
        ]);
        expect(board.rows[1]).toMatchObject({
            agent: { terminalId: 'terminal-2', kind: 'codex', processState: 'running' },
            botSession: true,
            pullRequest: { number: 7 },
            task: {
                delegationId: 'latest',
                status: 'failed',
                failure: 'startup_not_ready',
                updatedAt: 2,
            },
        });
        expect(board.rows[2]).toMatchObject({ agent: null, botSession: false });
        expect(board.rows[2]).not.toHaveProperty('task');
    });

    it('shows the head of each task chain, preferring an unsettled task over a newer settled one', () => {
        const board = botBoard({
            botTasks: [],
            botSessionIds: new Set(['session-1', 'session-2']),
            now: NOW,
            projects: [project],
            pullRequests: { pullRequests: {}, refreshedAt: 0 },
            sessions: [session({ id: 'session-1' }), session({ id: 'session-2' })],
            tasks: [
                task({
                    delegationId: 'asked',
                    sessionId: 'session-1',
                    status: 'completed',
                    createdAt: 1,
                }),
                task({
                    delegationId: 'answer',
                    sessionId: 'session-1',
                    followUpOf: 'asked',
                    createdAt: 2,
                }),
                task({
                    delegationId: 'side',
                    sessionId: 'session-1',
                    status: 'completed',
                    createdAt: 3,
                }),
                task({
                    delegationId: 'stuck',
                    sessionId: 'session-2',
                    status: 'blocked',
                    createdAt: 1,
                }),
                task({
                    delegationId: 'failed',
                    sessionId: 'session-2',
                    status: 'failed',
                    createdAt: 2,
                }),
            ],
            terminals: [],
        });

        expect(
            Object.fromEntries(
                board.rows.map(({ sessionId, task }) => [sessionId, task?.delegationId]),
            ),
        ).toEqual({ 'session-1': 'answer', 'session-2': 'stuck' });
    });

    it('keeps a waiting task on the board when its follow-up is rejected', () => {
        const board = botBoard({
            botTasks: [],
            botSessionIds: new Set(['session-1']),
            now: NOW,
            projects: [project],
            pullRequests: { pullRequests: {}, refreshedAt: 0 },
            sessions: [session({ id: 'session-1' })],
            tasks: [
                task({
                    delegationId: 'stuck',
                    sessionId: 'session-1',
                    status: 'blocked',
                    failure: 'startup_waiting',
                    createdAt: 1,
                }),
                task({
                    delegationId: 'rejected',
                    sessionId: 'session-1',
                    followUpOf: 'stuck',
                    status: 'failed',
                    failure: 'target_busy',
                    createdAt: 2,
                }),
            ],
            terminals: [terminal({ sessionId: 'session-1' })],
        });

        expect(board.rows[0]).toMatchObject({
            group: 'attention',
            task: { delegationId: 'stuck', status: 'blocked' },
        });
    });

    it.each([
        ['failed', 'startup_not_ready', 'idle'],
        ['failed', 'launch_failed', 'completed'],
        ['answer_unavailable', 'result_missing', 'completed'],
    ] as const)(
        'moves a %s task (%s) to failed over a Session that looks %s',
        (status, failure, lastActivityState) => {
            const board = botBoard({
                botTasks: [],
                botSessionIds: new Set(['session-1']),
                now: NOW,
                projects: [project],
                pullRequests: { pullRequests: {}, refreshedAt: 0 },
                sessions: [session({ id: 'session-1', lastActivityState })],
                tasks: [task({ sessionId: 'session-1', status, failure })],
                terminals: [terminal({ sessionId: 'session-1' })],
            });

            expect(board.rows[0]?.group).toBe('failed');
        },
    );

    it('keeps unread ahead of a failed task', () => {
        const board = botBoard({
            botTasks: [],
            botSessionIds: new Set(['session-1']),
            now: NOW,
            projects: [project],
            pullRequests: { pullRequests: {}, refreshedAt: 0 },
            sessions: [session({ id: 'session-1', hasUnread: true })],
            tasks: [task({ sessionId: 'session-1', status: 'failed', failure: 'launch_failed' })],
            terminals: [terminal({ sessionId: 'session-1' })],
        });

        expect(board.rows[0]?.group).toBe('attention');
    });

    it('puts a Session whose Agent waits at startup under attention', () => {
        const board = botBoard({
            botTasks: [],
            botSessionIds: new Set(['session-1']),
            now: NOW,
            projects: [project],
            pullRequests: { pullRequests: {}, refreshedAt: 0 },
            sessions: [session({ id: 'session-1' })],
            tasks: [
                task({ sessionId: 'session-1', status: 'blocked', failure: 'startup_waiting' }),
            ],
            terminals: [terminal({ sessionId: 'session-1' })],
        });

        expect(board.rows[0]?.group).toBe('attention');
    });
});
