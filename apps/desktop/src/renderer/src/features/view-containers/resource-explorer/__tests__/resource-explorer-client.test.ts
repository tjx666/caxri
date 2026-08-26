import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ request: vi.fn(), requestWithSignal: vi.fn() }));

vi.mock('../../../../lib/caxri', () => ({ caxri: mocks }));

import { createResourceExplorerClient } from '../resource-explorer-client';

afterEach(() => vi.clearAllMocks());

describe('ResourceExplorerClient', () => {
    it('calls the typed Files Core IPC with the selected Session scope', async () => {
        mocks.request.mockResolvedValue([]);
        const client = createResourceExplorerClient('publisher.files.explorer', 'session-1');

        await client.list('/project');

        expect(mocks.request).toHaveBeenCalledWith('files.list', {
            sessionId: 'session-1',
            directory: '/project',
        });
        expect(mocks.request).not.toHaveBeenCalledWith(
            'viewContainers.viewOperation',
            expect.anything(),
        );
    });

    it('uses the cancellable typed request path for a long-running search', async () => {
        const controller = new AbortController();
        mocks.requestWithSignal.mockResolvedValue({ results: [], truncated: false });
        const client = createResourceExplorerClient('publisher.files.explorer', 'session-1');

        await client.search({ mode: 'content', query: 'needle' }, controller.signal);

        expect(mocks.requestWithSignal).toHaveBeenCalledWith('files.search', controller.signal, {
            sessionId: 'session-1',
            mode: 'content',
            query: 'needle',
        });
    });

    it('scopes durable operation recovery and control to the selected Session', async () => {
        mocks.request.mockResolvedValue([]);
        const client = createResourceExplorerClient('publisher.files.explorer', 'session-1');

        await client.listOperations();
        await client.getOperation('operation-1');
        await client.cancelOperation('operation-1');
        await client.acknowledgeOperation('operation-1');

        expect(mocks.request.mock.calls).toEqual([
            ['files.operation.list', { sessionId: 'session-1' }],
            ['files.operation.get', { operationId: 'operation-1', sessionId: 'session-1' }],
            ['files.operation.cancel', { operationId: 'operation-1', sessionId: 'session-1' }],
            ['files.operation.acknowledge', { operationId: 'operation-1', sessionId: 'session-1' }],
        ]);
    });
});
