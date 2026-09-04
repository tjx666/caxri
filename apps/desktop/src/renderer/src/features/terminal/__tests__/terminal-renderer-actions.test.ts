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

import { confirmTerminalRendererSwitch } from '../terminal-renderer-actions';

const action = {
    confirmLabel: 'Turn On',
    message: 'Terminals switch from the DOM renderer to WebGL immediately.',
    preference: 'on' as const,
    title: 'Turn on GPU acceleration?',
};

beforeEach(() => {
    mocks.caxriRequest.mockClear();
    mocks.showConfirm.mockClear();
    mocks.tryCommand.mockClear();
});

describe('confirmTerminalRendererSwitch', () => {
    it('asks the question the chip advertised before writing anything', async () => {
        await confirmTerminalRendererSwitch(action);

        expect(mocks.showConfirm).toHaveBeenCalledWith({
            confirmLabel: 'Turn On',
            message: 'Terminals switch from the DOM renderer to WebGL immediately.',
            title: 'Turn on GPU acceleration?',
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
            'Unable to change GPU acceleration',
            expect.any(Function),
        );
    });
});
