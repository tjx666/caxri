import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    caxriRequest: vi.fn((): Promise<unknown> => Promise.resolve(undefined)),
}));

vi.mock('../../lib/caxri', () => ({ caxri: { request: mocks.caxriRequest } }));

import { detachTerminalQuietly, opaqueSearchColor } from './terminal-pane-support';

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
