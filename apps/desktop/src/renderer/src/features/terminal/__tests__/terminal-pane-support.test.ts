import type { Terminal } from '@xterm/xterm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    caxriRequest: vi.fn((): Promise<unknown> => Promise.resolve(undefined)),
}));

vi.mock('../../../lib/caxri', () => ({ caxri: { request: mocks.caxriRequest } }));

import { didPasteIntoTerminal } from '../terminal-actions';
import {
    detachTerminalQuietly,
    opaqueSearchColor,
    registerTerminalInputHandlers,
} from '../terminal-pane-support';

beforeEach(() => {
    mocks.caxriRequest.mockReset();
    mocks.caxriRequest.mockResolvedValue(undefined);
});

describe('opaqueSearchColor', () => {
    it('strips the trailing alpha byte from an 8-digit hex color', () => {
        expect(opaqueSearchColor('#282836ff')).toBe('#282836');
    });

    it('leaves an already-opaque 6-digit hex color unchanged', () => {
        expect(opaqueSearchColor('#282836')).toBe('#282836');
    });
});

describe('detachTerminalQuietly', () => {
    it('requests terminal.detach with the given terminal id', async () => {
        mocks.caxriRequest.mockResolvedValueOnce(undefined);

        await detachTerminalQuietly('terminal-1');

        expect(mocks.caxriRequest).toHaveBeenCalledWith('terminal.detach', {
            terminalId: 'terminal-1',
        });
    });

    it('swallows a rejecting request instead of throwing', async () => {
        mocks.caxriRequest.mockRejectedValueOnce(new Error('detach failed'));

        await expect(detachTerminalQuietly('terminal-1')).resolves.toBeUndefined();
    });
});

describe('registerTerminalInputHandlers', () => {
    it('routes typed and dropped input through one live xterm path', async () => {
        let onData: ((data: string) => void) | undefined;
        const dataDisposable = { dispose: vi.fn() };
        const focus = vi.fn();
        const paste = vi.fn();
        const terminal = {
            focus,
            onData: vi.fn((handler: (data: string) => void) => {
                onData = handler;
                return dataDisposable;
            }),
            paste,
        } as unknown as Terminal;
        const unregister = registerTerminalInputHandlers(terminal, 'terminal-input-1', () => true);

        onData?.('typed input');
        await vi.waitFor(() =>
            expect(mocks.caxriRequest).toHaveBeenCalledWith('terminal.input', {
                terminalId: 'terminal-input-1',
                data: 'typed input',
            }),
        );
        expect(didPasteIntoTerminal('terminal-input-1', "'/repo/a file.txt'")).toBe(true);
        expect(paste).toHaveBeenCalledWith("'/repo/a file.txt'");
        expect(focus).toHaveBeenCalledTimes(1);

        unregister();
        expect(dataDisposable.dispose).toHaveBeenCalledTimes(1);
        expect(didPasteIntoTerminal('terminal-input-1', '/repo/ignored')).toBe(false);
    });

    it('rejects typed and dropped input when the Terminal is stopped', () => {
        let onData: ((data: string) => void) | undefined;
        const paste = vi.fn();
        const terminal = {
            focus: vi.fn(),
            onData: vi.fn((handler: (data: string) => void) => {
                onData = handler;
                return { dispose: vi.fn() };
            }),
            paste,
        } as unknown as Terminal;
        const unregister = registerTerminalInputHandlers(terminal, 'terminal-input-2', () => false);

        onData?.('ignored input');

        expect(mocks.caxriRequest).not.toHaveBeenCalled();
        expect(didPasteIntoTerminal('terminal-input-2', '/repo/ignored')).toBe(false);
        expect(paste).not.toHaveBeenCalled();
        unregister();
    });
});
