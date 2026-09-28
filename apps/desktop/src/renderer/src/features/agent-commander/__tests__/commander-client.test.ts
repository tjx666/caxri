import type {
    BootstrapState,
    CommanderBoard,
    CommanderBoardRow,
    CommanderSnapshot,
    SessionPullRequests,
} from '@caxri/protocol';
import { defaultAppSettings } from '@caxri/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../../lib/caxri', () => ({ caxri: { request: mocks.request } }));

import { caxriQueryKey, queryClient } from '../../../queries/client';
import {
    configureWorkbenchSnapshotSource,
    refreshWorkbench,
    useWorkbenchStore,
} from '../../../stores/workbench';
import {
    ensureAgentCommander,
    readAgentCommanderWorkbench,
    refreshCommanderBoardPullRequests,
    useAgentCommanderStore,
} from '../commander-client';

function snapshot(terminalId: string): CommanderSnapshot {
    return {
        identity: { projectId: 'commander-project', sessionId: 'commander-session', terminalId },
        workspacePath: '/workspace/commander',
        workbench: {
            keybindingConflicts: [],
            keybindings: [],
            projects: [],
            runtime: { restartCount: 0, status: 'ready' },
            sessionStates: [],
            sessions: [],
            settings: defaultAppSettings,
            terminals: [{ id: terminalId, sessionId: 'commander-session' }],
            theme: {},
        } as unknown as BootstrapState,
    };
}

function storedTerminalIds(): string[] | undefined {
    return useWorkbenchStore.getState().bootstrap?.terminals.map((terminal) => terminal.id);
}

describe('Agent Commander snapshot', () => {
    beforeEach(() => {
        mocks.request.mockReset();
        useWorkbenchStore.setState({ bootstrap: undefined });
        useAgentCommanderStore.setState({ identity: undefined, workspacePath: undefined });
    });

    it('seeds the Workbench store and identity from one shared ensure request', async () => {
        const reply = Promise.withResolvers<CommanderSnapshot>();
        mocks.request.mockReturnValueOnce(reply.promise);

        const first = ensureAgentCommander();
        const second = ensureAgentCommander();
        reply.resolve(snapshot('commander-terminal'));
        await Promise.all([first, second]);

        expect(mocks.request).toHaveBeenCalledOnce();
        expect(mocks.request).toHaveBeenCalledWith('commander.ensure');
        expect(storedTerminalIds()).toEqual(['commander-terminal']);
        expect(useAgentCommanderStore.getState()).toMatchObject({
            identity: { terminalId: 'commander-terminal' },
            workspacePath: '/workspace/commander',
        });
    });

    it('lets a failed ensure be retried', async () => {
        mocks.request.mockRejectedValueOnce(new Error('Server unavailable'));
        await expect(ensureAgentCommander()).rejects.toThrow('Server unavailable');

        mocks.request.mockResolvedValueOnce(snapshot('commander-terminal'));
        await ensureAgentCommander();

        expect(mocks.request).toHaveBeenCalledTimes(2);
        expect(storedTerminalIds()).toEqual(['commander-terminal']);
    });

    it('routes every Workbench refresh through commander.snapshot instead of app.bootstrap', async () => {
        configureWorkbenchSnapshotSource(readAgentCommanderWorkbench);
        mocks.request.mockResolvedValueOnce(snapshot('replacement-terminal'));

        await refreshWorkbench();

        expect(mocks.request.mock.calls).toEqual([['commander.snapshot']]);
        expect(storedTerminalIds()).toEqual(['replacement-terminal']);
        expect(useAgentCommanderStore.getState().identity?.terminalId).toBe('replacement-terminal');
    });

    it('reports a Commander that no longer exists instead of emptying the store', async () => {
        mocks.request.mockResolvedValueOnce(null);

        await expect(readAgentCommanderWorkbench()).rejects.toThrow(
            'Agent Commander is no longer set up',
        );
        expect(useAgentCommanderStore.getState().identity).toBeUndefined();
    });
});

/**
 * A pull-request change patches the named rows in place rather than invalidating the whole board (issue caxri#1411), so
 * the rows it did not name keep their objects and do not re-render.
 */
describe('refreshCommanderBoardPullRequests', () => {
    const boardKey = caxriQueryKey('commander.board', undefined);

    function boardRow(
        sessionId: string,
        overrides: Partial<CommanderBoardRow> = {},
    ): CommanderBoardRow {
        return {
            activityState: 'idle',
            agent: null,
            commanderSession: false,
            group: 'idle',
            hasUnread: false,
            lastActivityAt: 0,
            projectId: 'project-1',
            projectRoot: '/workspace/alpha',
            projectTitle: 'alpha',
            sessionId,
            sessionTitle: sessionId,
            ...overrides,
        };
    }

    function pullRequests(overrides: Partial<SessionPullRequests> = {}): SessionPullRequests {
        return { pullRequests: {}, refreshedAt: 5, ...overrides };
    }

    const opened = {
        number: 42,
        source: 'branch',
        state: 'open',
        title: 'Parser fix',
        url: 'https://example.com/pull/42',
    } as const;

    beforeEach(() => {
        mocks.request.mockReset();
        queryClient.clear();
    });

    afterEach(() => {
        queryClient.clear();
    });

    it('patches only the named rows from one fresh read, without refetching the board', async () => {
        const untouched = boardRow('untouched');
        const target = boardRow('target');
        queryClient.setQueryData<CommanderBoard>(boardKey, {
            generatedAt: 1,
            projects: [],
            pullRequestsRefreshedAt: 1,
            rows: [untouched, target],
        });
        const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
        mocks.request.mockResolvedValueOnce(
            pullRequests({ pullRequests: { target: opened, untouched: opened } }),
        );

        await refreshCommanderBoardPullRequests(new Set(['target']));

        expect(mocks.request.mock.calls).toEqual([['session.pullRequests', undefined]]);
        expect(invalidate).not.toHaveBeenCalled();
        const board = queryClient.getQueryData<CommanderBoard>(boardKey);
        expect(board?.rows[0]).toBe(untouched);
        expect(board?.rows[1]).toEqual({ ...target, pullRequest: opened });
        expect(board?.pullRequestsRefreshedAt).toBe(5);
        invalidate.mockRestore();
    });

    it('re-reads a snapshot this window cached moments ago, because the event says it is stale', async () => {
        queryClient.setQueryData(caxriQueryKey('session.pullRequests', undefined), pullRequests());
        queryClient.setQueryData<CommanderBoard>(boardKey, {
            generatedAt: 1,
            projects: [],
            pullRequestsRefreshedAt: 1,
            rows: [boardRow('target')],
        });
        mocks.request.mockResolvedValueOnce(pullRequests({ pullRequests: { target: opened } }));

        await refreshCommanderBoardPullRequests(new Set(['target']));

        expect(mocks.request).toHaveBeenCalledOnce();
        expect(queryClient.getQueryData<CommanderBoard>(boardKey)?.rows[0]?.pullRequest).toEqual(
            opened,
        );
    });

    it('asks a board that has not loaded yet to read again instead of patching it', async () => {
        const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

        await refreshCommanderBoardPullRequests(new Set(['target']));

        expect(invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: boardKey });
        expect(mocks.request).not.toHaveBeenCalled();
        expect(queryClient.getQueryData(boardKey)).toBeUndefined();
        invalidate.mockRestore();
    });
});
