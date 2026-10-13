import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    caxriRequest: vi.fn((): Promise<unknown> => Promise.resolve(undefined)),
    showConfirm: vi.fn((): Promise<boolean> => Promise.resolve(false)),
    /**
     * Mirrors the real `tryCommand`: it swallows the rejection after reporting it, so the caller never has to.
     */
    tryCommand: vi.fn(async (...[, run]: [string, () => Promise<unknown>]): Promise<unknown> => {
        try {
            return await run();
        } catch {
            return undefined;
        }
    }),
}));

vi.mock('../../../lib/caxri', () => ({
    caxri: { request: mocks.caxriRequest, window: { showConfirm: mocks.showConfirm } },
}));
vi.mock('../../../stores/toasts', () => ({ tryCommand: mocks.tryCommand }));

import { confirmTerminalRendererSwitch } from '../terminal-renderer-commands';
import { registerTerminalRendererRetry } from '../terminal-renderer-status';

const action = {
    confirmLabel: 'Turn On',
    message: 'Terminals start drawing with the GPU immediately.',
    preference: 'on' as const,
    title: 'Turn on Terminal hardware acceleration?',
};

beforeEach(() => {
    mocks.caxriRequest.mockClear();
    mocks.showConfirm.mockClear();
    mocks.tryCommand.mockClear();
});

describe('confirmTerminalRendererSwitch', () => {
    const retryAction = {
        confirmLabel: 'Retry GPU',
        message: 'Retry this Terminal.',
        title: 'Retry GPU rendering?',
    };

    it('retries the current renderer only after confirmation without writing settings', async () => {
        const retry = vi.fn(() => true);
        const unregister = registerTerminalRendererRetry('t1', retry);
        mocks.showConfirm.mockResolvedValueOnce(false);
        await confirmTerminalRendererSwitch(retryAction, 't1');
        expect(retry).not.toHaveBeenCalled();
        mocks.showConfirm.mockResolvedValueOnce(true);
        await confirmTerminalRendererSwitch(retryAction, 't1');
        expect(retry).toHaveBeenCalledTimes(1);
        expect(mocks.caxriRequest).not.toHaveBeenCalled();
        unregister();
    });

    it('ignores confirmation for a replaced pane and reports a failed retry', async () => {
        const retry = vi.fn(() => false);
        const unregister = registerTerminalRendererRetry('t1', retry);
        mocks.showConfirm.mockImplementationOnce(() => {
            unregister();
            return Promise.resolve(true);
        });
        await confirmTerminalRendererSwitch(retryAction, 't1');
        expect(retry).not.toHaveBeenCalled();
        const remove = registerTerminalRendererRetry('t1', retry);
        mocks.showConfirm.mockResolvedValueOnce(true);
        await confirmTerminalRendererSwitch(retryAction, 't1');
        expect(retry).toHaveBeenCalledTimes(1);
        expect(mocks.tryCommand).toHaveBeenLastCalledWith(
            'Unable to restore GPU rendering',
            expect.any(Function),
        );
        remove();
    });
    it('asks the question the chip advertised before writing anything', async () => {
        await confirmTerminalRendererSwitch(action);

        expect(mocks.showConfirm).toHaveBeenCalledWith({
            confirmLabel: 'Turn On',
            message: 'Terminals start drawing with the GPU immediately.',
            title: 'Turn on Terminal hardware acceleration?',
        });
    });

    it('leaves the preference untouched when the user cancels', async () => {
        mocks.showConfirm.mockResolvedValueOnce(false);

        await confirmTerminalRendererSwitch(action);

        expect(mocks.caxriRequest).not.toHaveBeenCalled();
    });

    it('patches only the GPU acceleration key once confirmed', async () => {
        mocks.showConfirm.mockResolvedValueOnce(true);

        await confirmTerminalRendererSwitch(action);

        expect(mocks.caxriRequest).toHaveBeenCalledWith('settings.patch', {
            changes: [{ key: 'terminal.gpuAcceleration', value: 'on' }],
        });
    });

    it('funnels a rejected write through the shared failure reporter', async () => {
        mocks.showConfirm.mockResolvedValueOnce(true);
        mocks.caxriRequest.mockRejectedValueOnce(new Error('settings are read-only'));

        await expect(confirmTerminalRendererSwitch(action)).resolves.toBeUndefined();
        expect(mocks.tryCommand).toHaveBeenCalledWith(
            'Unable to change Terminal hardware acceleration',
            expect.any(Function),
        );
    });
});
