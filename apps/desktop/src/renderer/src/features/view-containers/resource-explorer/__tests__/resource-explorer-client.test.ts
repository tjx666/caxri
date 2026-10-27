import type { BootstrapState } from '@caxri/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ request: vi.fn(), requestWithSignal: vi.fn() }));

vi.mock('../../../../lib/caxri', () => ({ caxri: mocks }));

import { useWorkbenchStore } from '../../../../stores/workbench';
import { createResourceExplorerClient } from '../resource-explorer-client';

function selectSession(sessionId: string): void {
    useWorkbenchStore.setState({
        bootstrap: {
            selectedSessionId: sessionId,
            sessions: [
                { id: 'session-1', projectId: 'project-1', workbenchRootProjectId: 'project-1' },
                { id: 'session-2', projectId: 'project-1', workbenchRootProjectId: 'project-1' },
            ],
            sessionStates: [],
        } as unknown as BootstrapState,
    });
}

beforeEach(() => selectSession('session-1'));

afterEach(() => {
    vi.clearAllMocks();
    useWorkbenchStore.setState({ bootstrap: undefined });
});

describe('ResourceExplorerClient', () => {
    it('calls the typed Files Core IPC with the selected Session scope', async () => {
        mocks.request.mockResolvedValue([]);
        const client = createResourceExplorerClient('publisher.files.explorer');

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

    it('scopes durable operation recovery and control to the selected Session', async () => {
        mocks.request.mockResolvedValue([]);
        const client = createResourceExplorerClient('publisher.files.explorer');

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

    /**
     * The client is built once per view and deliberately does not capture the Session: rebuilding it on every switch
     * gave the controlled-view context a new identity, which re-rendered every file-tree row under it (issue #784).
     */
    it('follows a Session switch without being rebuilt', async () => {
        mocks.request.mockResolvedValue([]);
        const client = createResourceExplorerClient('publisher.files.explorer');

        await client.list('/project');
        selectSession('session-2');
        await client.list('/project');

        expect(mocks.request.mock.calls).toEqual([
            ['files.list', { sessionId: 'session-1', directory: '/project' }],
            ['files.list', { sessionId: 'session-2', directory: '/project' }],
        ]);
    });

    it('rejects a request made while no Session is selected', async () => {
        useWorkbenchStore.setState({ bootstrap: undefined });
        const client = createResourceExplorerClient('publisher.files.explorer');

        await expect(client.list('/project')).rejects.toThrow('No Session is selected');
        expect(mocks.request).not.toHaveBeenCalled();
    });
});
