import { CaxriError } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { shouldContinueStartup } from '../server-startup';

function harness(responses: number[] = []) {
    const showMessageBox = vi.fn(() => Promise.resolve({ response: responses.shift() ?? 0 }));
    const openPath = vi.fn(() => Promise.resolve(''));
    const quit = vi.fn();
    const write = vi.fn();
    return {
        openPath,
        quit,
        showMessageBox,
        write,
        options: {
            dialog: { showMessageBox },
            logDirectory: '/data/logs',
            logger: { write } as never,
            openPath,
            quit,
            userDataPath: '/data',
        },
    };
}

describe('Server startup boundary', () => {
    it('attaches once without a dialog', async () => {
        const h = harness();
        const start = vi.fn(() => Promise.resolve());

        await expect(shouldContinueStartup({ ...h.options, supervisor: { start } })).resolves.toBe(
            true,
        );

        expect(start).toHaveBeenCalledOnce();
        expect(h.showMessageBox).not.toHaveBeenCalled();
        expect(h.quit).not.toHaveBeenCalled();
    });

    it('explains a protocol mismatch in user language and reveals the data folder', async () => {
        const error = new CaxriError('CONFLICT', 'Caxri Host protocol version is incompatible', {
            clientProtocolVersion: 2,
            hostProtocolVersion: 1,
        });
        const h = harness([0, 1]);
        const start = vi.fn(() => Promise.reject(error));

        await expect(shouldContinueStartup({ ...h.options, supervisor: { start } })).resolves.toBe(
            false,
        );

        expect(start).toHaveBeenCalledOnce();
        const [shown] = h.showMessageBox.mock.calls[0] as unknown as [
            { buttons: string[]; detail: string },
        ];
        expect(shown.buttons).toEqual(['Reveal Data Folder', 'Quit']);
        expect(shown.detail).not.toMatch(/bun|uninstall/u);
        expect(h.openPath).toHaveBeenCalledWith('/data');
        expect(h.showMessageBox).toHaveBeenCalledTimes(2);
        expect(h.quit).toHaveBeenCalledOnce();
    });

    it('offers Try Again for an unrelated failure and continues once the retry succeeds', async () => {
        const h = harness([0]);
        const start = vi
            .fn()
            .mockRejectedValueOnce(new Error('socket unavailable'))
            .mockResolvedValueOnce(undefined);

        await expect(shouldContinueStartup({ ...h.options, supervisor: { start } })).resolves.toBe(
            true,
        );

        expect(start).toHaveBeenCalledTimes(2);
        expect(h.quit).not.toHaveBeenCalled();
        const [level, , record] = h.write.mock.calls[0] as [
            string,
            string,
            { fields: Record<string, unknown> },
        ];
        expect(level).toBe('error');
        expect(record.fields).toMatchObject({ attempt: 1, reason: 'unknown' });
    });

    it('reveals logs without retrying, then quits', async () => {
        const h = harness([1, 2]);
        const start = vi.fn(() => Promise.reject(new Error('Server start timed out')));

        await expect(shouldContinueStartup({ ...h.options, supervisor: { start } })).resolves.toBe(
            false,
        );

        expect(start).toHaveBeenCalledOnce();
        expect(h.openPath).toHaveBeenCalledWith('/data/logs');
        expect(h.quit).toHaveBeenCalledOnce();
    });
});
