import { describe, expect, it, vi } from 'vitest';

import type { CodexThreadSettings } from '../codex-chat-types';
import { openCodexThread, readCodexThreadTurns } from '../codex-thread-open';
import type { JsonRpcConnection } from '../json-rpc-connection';

const settings: CodexThreadSettings = {
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: 'workspace-write',
    rootArgs: [],
};

/**
 * A connection whose `config/read` answers with `config` (or fails when it is an Error) and whose `thread/start`
 * returns a thread, recording every request.
 */
function connection(config: Record<string, unknown> | Error) {
    const request = vi.fn<(method: string, parameters?: unknown) => Promise<unknown>>((method) => {
        if (method === 'config/read')
            return config instanceof Error
                ? Promise.reject(config)
                : Promise.resolve({ config, origins: {} });
        return Promise.resolve({ thread: { id: 'thread-1' } });
    });
    return {
        request,
        close: vi.fn(() => Promise.resolve()),
        startParameters: () =>
            request.mock.calls.find(([method]) => method === 'thread/start')?.[1],
    } as unknown as JsonRpcConnection & {
        request: typeof request;
        startParameters: () => Record<string, unknown>;
    };
}

describe('openCodexThread resume', () => {
    it('resumes without turns and reads a paginated history page by page', async () => {
        const request = vi.fn<(method: string, parameters?: unknown) => Promise<unknown>>(
            (method) => {
                if (method === 'thread/resume')
                    return Promise.resolve({
                        thread: { id: 'thread-1', historyMode: 'paginated', turns: [] },
                    });
                return Promise.resolve({ data: [{ id: 'turn-1', items: [] }], nextCursor: null });
            },
        );
        const codex = {
            request,
            close: vi.fn(() => Promise.resolve()),
        } as unknown as JsonRpcConnection;

        const opened = await openCodexThread(codex, {
            cwd: '/project',
            settings,
            threadId: 'thread-1',
        });

        expect(request.mock.calls[0]?.[1]).toMatchObject({ excludeTurns: true });
        expect(opened).toMatchObject({
            outcome: 'resumed',
            thread: { turns: [{ id: 'turn-1', items: [] }] },
        });
    });
});

describe('openCodexThread instructions', () => {
    it("keeps the user's configured developer instructions ahead of Caxri's", async () => {
        const codex = connection({ developer_instructions: 'Answer in Chinese.' });
        await openCodexThread(codex, { cwd: '/project', settings, instructions: 'Use Caxri.' });

        expect(codex.startParameters().developerInstructions).toBe(
            'Answer in Chinese.\n\nUse Caxri.',
        );
    });

    it('sends only Caxri instructions when the user configured none', async () => {
        const codex = connection({ developer_instructions: null });
        await openCodexThread(codex, { cwd: '/project', settings, instructions: 'Use Caxri.' });

        expect(codex.startParameters().developerInstructions).toBe('Use Caxri.');
    });

    it("leaves the user's instructions in place when Codex cannot report them", async () => {
        const codex = connection(new Error('config/read unsupported'));
        await openCodexThread(codex, { cwd: '/project', settings, instructions: 'Use Caxri.' });

        expect(codex.startParameters()).not.toHaveProperty('developerInstructions');
    });

    it('does not read the config when there is nothing to add', async () => {
        const codex = connection({ developer_instructions: 'Answer in Chinese.' });
        await openCodexThread(codex, { cwd: '/project', settings });

        expect(codex.request).not.toHaveBeenCalledWith(
            'config/read',
            expect.anything(),
            expect.anything(),
        );
        expect(codex.startParameters()).not.toHaveProperty('developerInstructions');
    });
});

type Request = (method: string, parameters?: unknown, timeoutMs?: number) => Promise<unknown>;

const turn = (id: string) => ({ id, status: 'completed', items: [] });

describe('readCodexThreadTurns', () => {
    it('pages a paginated thread oldest first until Codex reports no next cursor', async () => {
        const pages: Record<string, unknown> = {
            first: { data: [turn('t1'), turn('t2')], nextCursor: 'c2' },
            c2: { data: [turn('t3')], nextCursor: null },
        };
        const request = vi.fn<Request>((_method, parameters) =>
            Promise.resolve(pages[(parameters as { cursor?: string }).cursor ?? 'first']),
        );

        const turns = await readCodexThreadTurns(
            request,
            { id: 'thread-1', historyMode: 'paginated' },
            1000,
        );

        expect(turns.map((entry) => (entry as { id: string }).id)).toEqual(['t1', 't2', 't3']);
        expect(request.mock.calls.map(([method, parameters]) => [method, parameters])).toEqual([
            [
                'thread/turns/list',
                { threadId: 'thread-1', limit: 100, sortDirection: 'asc', itemsView: 'full' },
            ],
            [
                'thread/turns/list',
                {
                    threadId: 'thread-1',
                    limit: 100,
                    sortDirection: 'asc',
                    itemsView: 'full',
                    cursor: 'c2',
                },
            ],
        ]);
    });

    it('stops when a cursor does not advance', async () => {
        const request = vi.fn<Request>(() =>
            Promise.resolve({ data: [turn('t1')], nextCursor: 'same' }),
        );

        await readCodexThreadTurns(request, { id: 'thread-1', historyMode: 'paginated' }, 1000);

        expect(request).toHaveBeenCalledTimes(2);
    });

    it('reads a legacy thread whole with thread/read', async () => {
        const request = vi.fn<Request>(() =>
            Promise.resolve({ thread: { id: 'thread-1', turns: [turn('t1')] } }),
        );

        const turns = await readCodexThreadTurns(
            request,
            { id: 'thread-1', historyMode: 'legacy' },
            1000,
        );

        expect(turns).toEqual([turn('t1')]);
        expect(request).toHaveBeenCalledWith(
            'thread/read',
            { threadId: 'thread-1', includeTurns: true },
            1000,
        );
    });

    it('rejects a page that is not a turn list', async () => {
        const request = vi.fn<Request>(() => Promise.resolve({}));

        await expect(
            readCodexThreadTurns(request, { id: 'thread-1', historyMode: 'paginated' }, 1000),
        ).rejects.toThrow('no turns page');
    });
});
