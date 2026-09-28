import { describe, expect, it, vi } from 'vitest';

import type { AgentCommanderWindowController } from '../agent-commander-window';
import {
    persistAllWindowState,
    reopenAuxiliaryWindowsAtStartup,
} from '../auxiliary-window-lifecycle';
import type { ProcessExplorerWindowController } from '../process-explorer-window';

function fakeAgentCommander(wasOpenAtQuit: boolean) {
    return {
        loadPersistedState: vi.fn().mockResolvedValue(wasOpenAtQuit),
        open: vi.fn(),
    } as unknown as AgentCommanderWindowController & {
        loadPersistedState: () => Promise<boolean>;
        open: () => void;
    };
}

function fakeProcessExplorer() {
    return {
        loadPersistedState: vi.fn().mockResolvedValue(undefined),
    } as unknown as ProcessExplorerWindowController & { loadPersistedState: () => Promise<void> };
}

describe('reopenAuxiliaryWindowsAtStartup', () => {
    it('reopens the Commander when it was open at the previous quit', async () => {
        const agentCommander = fakeAgentCommander(true);
        const processExplorer = fakeProcessExplorer();

        await reopenAuxiliaryWindowsAtStartup(agentCommander, processExplorer);

        expect(agentCommander.open).toHaveBeenCalledOnce();
        expect(processExplorer.loadPersistedState).toHaveBeenCalledOnce();
    });

    it('leaves the Commander closed when it was closed at the previous quit', async () => {
        const agentCommander = fakeAgentCommander(false);
        const processExplorer = fakeProcessExplorer();

        await reopenAuxiliaryWindowsAtStartup(agentCommander, processExplorer);

        expect(agentCommander.open).not.toHaveBeenCalled();
    });

    it('never reopens Process Explorer on its own, only loads its remembered bounds', async () => {
        const processExplorer = fakeProcessExplorer();

        await reopenAuxiliaryWindowsAtStartup(fakeAgentCommander(false), processExplorer);

        expect(processExplorer.loadPersistedState).toHaveBeenCalledOnce();
    });

    it('treats a missing Commander controller as closed, without throwing', async () => {
        const processExplorer = fakeProcessExplorer();

        await expect(
            reopenAuxiliaryWindowsAtStartup(undefined, processExplorer),
        ).resolves.toBeUndefined();
    });
});

describe('persistAllWindowState', () => {
    it('awaits every persister', async () => {
        const first = vi.fn().mockResolvedValue(undefined);
        const second = vi.fn().mockResolvedValue(undefined);

        await persistAllWindowState([first, second]);

        expect(first).toHaveBeenCalledOnce();
        expect(second).toHaveBeenCalledOnce();
    });

    it('runs every persister even when an earlier one fails, then surfaces the failure', async () => {
        const second = vi.fn().mockResolvedValue(undefined);

        await expect(
            persistAllWindowState([() => Promise.reject(new Error('window gone')), second]),
        ).rejects.toThrow('window gone');
        expect(second).toHaveBeenCalledOnce();
    });

    it('treats a persister returning undefined as nothing to persist', async () => {
        await expect(persistAllWindowState([() => {}])).resolves.toBeUndefined();
    });
});
