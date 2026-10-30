import { describe, expect, it, vi } from 'vitest';

import type { CaxriBotWindowController } from '../../caxri-bot-window';
import type { ProcessExplorerWindowController } from '../../process-explorer/window';
import { persistAllWindowState, reopenAuxiliaryWindowsAtStartup } from '../lifecycle';

function fakeCaxriBot(wasOpenAtQuit: boolean) {
    return {
        loadPersistedState: vi.fn().mockResolvedValue(wasOpenAtQuit),
        open: vi.fn(),
    } as unknown as CaxriBotWindowController & {
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
    it('reopens Caxri Bot when it was open at the previous quit', async () => {
        const caxriBot = fakeCaxriBot(true);
        const processExplorer = fakeProcessExplorer();

        await reopenAuxiliaryWindowsAtStartup(caxriBot, processExplorer);

        expect(caxriBot.open).toHaveBeenCalledOnce();
        expect(processExplorer.loadPersistedState).toHaveBeenCalledOnce();
    });

    it('leaves Caxri Bot closed when it was closed at the previous quit', async () => {
        const caxriBot = fakeCaxriBot(false);
        const processExplorer = fakeProcessExplorer();

        await reopenAuxiliaryWindowsAtStartup(caxriBot, processExplorer);

        expect(caxriBot.open).not.toHaveBeenCalled();
    });

    it('never reopens Process Explorer on its own, only loads its remembered bounds', async () => {
        const processExplorer = fakeProcessExplorer();

        await reopenAuxiliaryWindowsAtStartup(fakeCaxriBot(false), processExplorer);

        expect(processExplorer.loadPersistedState).toHaveBeenCalledOnce();
    });

    it('treats a missing Caxri Bot controller as closed, without throwing', async () => {
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

    it('still runs every persister when an earlier one throws synchronously instead of rejecting', async () => {
        const third = vi.fn().mockResolvedValue(undefined);

        await expect(
            persistAllWindowState([
                () => {
                    throw new Error('destroyed mid-read');
                },
                () => Promise.resolve(),
                third,
            ]),
        ).rejects.toThrow('destroyed mid-read');
        expect(third).toHaveBeenCalledOnce();
    });
});
