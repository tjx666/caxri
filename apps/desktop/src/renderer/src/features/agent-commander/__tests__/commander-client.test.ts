import type { BootstrapState, CommanderSnapshot } from '@caxri/protocol';
import { defaultAppSettings } from '@caxri/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../../lib/caxri', () => ({ caxri: { request: mocks.request } }));

import {
    configureWorkbenchSnapshotSource,
    refreshWorkbench,
    useWorkbenchStore,
} from '../../../stores/workbench';
import {
    ensureAgentCommander,
    readAgentCommanderWorkbench,
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
