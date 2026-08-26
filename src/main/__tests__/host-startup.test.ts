import { CaxriError } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { shouldContinueStartup } from '../host-startup';

describe('Host startup boundary', () => {
    it('attaches once without a legacy compatibility retry', async () => {
        const start = vi.fn(() => Promise.resolve());
        const dialog = { showErrorBox: vi.fn() };
        const quit = vi.fn();

        await expect(shouldContinueStartup({ dialog, quit, supervisor: { start } })).resolves.toBe(
            true,
        );

        expect(start).toHaveBeenCalledOnce();
        expect(dialog.showErrorBox).not.toHaveBeenCalled();
        expect(quit).not.toHaveBeenCalled();
    });

    it('directs an unpublished protocol mismatch to the explicit uninstall command', async () => {
        const error = new CaxriError('CONFLICT', 'Caxri Host protocol version is incompatible', {
            clientProtocolVersion: 2,
            hostProtocolVersion: 1,
        });
        const dialog = { showErrorBox: vi.fn() };
        const quit = vi.fn();
        const start = vi.fn(() => Promise.reject(error));

        await expect(shouldContinueStartup({ dialog, quit, supervisor: { start } })).resolves.toBe(
            false,
        );

        expect(start).toHaveBeenCalledOnce();
        expect(dialog.showErrorBox).toHaveBeenCalledWith(
            'Caxri requires a local reset',
            expect.stringMatching(/bun run uninstall:caxri\nbun run uninstall:caxri -- --yes/u),
        );
        expect(quit).toHaveBeenCalledOnce();
    });

    it('preserves the degraded Workbench for an unrelated startup failure', async () => {
        const dialog = { showErrorBox: vi.fn() };
        const quit = vi.fn();
        const start = vi.fn(() => Promise.reject(new Error('socket unavailable')));

        await expect(shouldContinueStartup({ dialog, quit, supervisor: { start } })).resolves.toBe(
            true,
        );

        expect(dialog.showErrorBox).not.toHaveBeenCalled();
        expect(quit).not.toHaveBeenCalled();
    });
});
