import type {
    BootstrapState,
    BotBoard,
    BotBoardRow,
    BotSnapshot,
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
    ensureCaxriBot,
    readCaxriBotWorkbench,
    refreshBotBoardPullRequests,
    useCaxriBotStore,
} from '../bot-client';

function snapshot(terminalId: string): BotSnapshot {
    return {
        identity: { projectId: 'bot-project', sessionId: 'bot-session', terminalId },
        workspacePath: '/workspace/bot',
        workbench: {
            keybindingConflicts: [],
            keybindings: [],
            projects: [],
            runtime: { restartCount: 0, status: 'ready' },
            sessionStates: [],
            sessions: [],
            settings: defaultAppSettings,
            terminals: [{ id: terminalId, sessionId: 'bot-session' }],
            theme: {},
        } as unknown as BootstrapState,
    };
}

function storedTerminalIds(): string[] | undefined {
    return useWorkbenchStore.getState().bootstrap?.terminals.map((terminal) => terminal.id);
}

describe('Caxri Bot snapshot', () => {
    beforeEach(() => {
        mocks.request.mockReset();
        useWorkbenchStore.setState({ bootstrap: undefined });
        useCaxriBotStore.setState({ identity: undefined, workspacePath: undefined });
    });

    it('seeds the Workbench store and identity from one shared ensure request', async () => {
        const reply = Promise.withResolvers<BotSnapshot>();
        mocks.request.mockReturnValueOnce(reply.promise);

        const first = ensureCaxriBot();
        const second = ensureCaxriBot();
        reply.resolve(snapshot('bot-terminal'));
        await Promise.all([first, second]);

        expect(mocks.request).toHaveBeenCalledOnce();
        expect(mocks.request).toHaveBeenCalledWith('bot.ensure');
        expect(storedTerminalIds()).toEqual(['bot-terminal']);
        expect(useCaxriBotStore.getState()).toMatchObject({
            identity: { terminalId: 'bot-terminal' },
            workspacePath: '/workspace/bot',
        });
    });

    it('lets a failed ensure be retried', async () => {
        mocks.request.mockRejectedValueOnce(new Error('Server unavailable'));
        await expect(ensureCaxriBot()).rejects.toThrow('Server unavailable');

        mocks.request.mockResolvedValueOnce(snapshot('bot-terminal'));
        await ensureCaxriBot();

        expect(mocks.request).toHaveBeenCalledTimes(2);
        expect(storedTerminalIds()).toEqual(['bot-terminal']);
    });

    it('routes every Workbench refresh through bot.snapshot instead of app.bootstrap', async () => {
        configureWorkbenchSnapshotSource(readCaxriBotWorkbench);
        mocks.request.mockResolvedValueOnce(snapshot('replacement-terminal'));

        await refreshWorkbench();

        expect(mocks.request.mock.calls).toEqual([['bot.snapshot']]);
        expect(storedTerminalIds()).toEqual(['replacement-terminal']);
        expect(useCaxriBotStore.getState().identity?.terminalId).toBe('replacement-terminal');
    });

    it('reports a Caxri Bot that no longer exists instead of emptying the store', async () => {
        mocks.request.mockResolvedValueOnce(null);

        await expect(readCaxriBotWorkbench()).rejects.toThrow('Caxri Bot is no longer set up');
        expect(useCaxriBotStore.getState().identity).toBeUndefined();
    });
});

/**
 * A pull-request change patches the named rows in place rather than invalidating the whole board (issue caxri#1411), so
 * the rows it did not name keep their objects and do not re-render.
 */
describe('refreshBotBoardPullRequests', () => {
    const boardKey = caxriQueryKey('bot.board', undefined);

    function boardRow(sessionId: string, overrides: Partial<BotBoardRow> = {}): BotBoardRow {
        return {
            activityState: 'idle',
            agent: null,
            botSession: false,
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
        queryClient.setQueryData<BotBoard>(boardKey, {
            generatedAt: 1,
            projects: [],
            pullRequestsRefreshedAt: 1,
            rows: [untouched, target],
            tasks: [],
        });
        const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
        mocks.request.mockResolvedValueOnce(
            pullRequests({ pullRequests: { target: opened, untouched: opened } }),
        );

        await refreshBotBoardPullRequests(new Set(['target']));

        expect(mocks.request.mock.calls).toEqual([['session.pullRequests', undefined]]);
        expect(invalidate).not.toHaveBeenCalled();
        const board = queryClient.getQueryData<BotBoard>(boardKey);
        expect(board?.rows[0]).toBe(untouched);
        expect(board?.rows[1]).toEqual({ ...target, pullRequest: opened });
        expect(board?.pullRequestsRefreshedAt).toBe(5);
        invalidate.mockRestore();
    });

    it('re-reads a snapshot this window cached moments ago, because the event says it is stale', async () => {
        queryClient.setQueryData(caxriQueryKey('session.pullRequests', undefined), pullRequests());
        queryClient.setQueryData<BotBoard>(boardKey, {
            generatedAt: 1,
            projects: [],
            pullRequestsRefreshedAt: 1,
            rows: [boardRow('target')],
            tasks: [],
        });
        mocks.request.mockResolvedValueOnce(pullRequests({ pullRequests: { target: opened } }));

        await refreshBotBoardPullRequests(new Set(['target']));

        expect(mocks.request).toHaveBeenCalledOnce();
        expect(queryClient.getQueryData<BotBoard>(boardKey)?.rows[0]?.pullRequest).toEqual(opened);
    });

    it('asks a board that has not loaded yet to read again instead of patching it', async () => {
        const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

        await refreshBotBoardPullRequests(new Set(['target']));

        expect(invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: boardKey });
        expect(mocks.request).not.toHaveBeenCalled();
        expect(queryClient.getQueryData(boardKey)).toBeUndefined();
        invalidate.mockRestore();
    });
});
