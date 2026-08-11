import { describe, expect, it, vi } from 'vitest';

import { openExternalUrl } from '../external-links';

function dependencies(confirm = true) {
    return {
        confirm: vi.fn(() => Promise.resolve(confirm)),
        open: vi.fn(() => Promise.resolve()),
    };
}

describe('openExternalUrl', () => {
    it.each([
        ['not a URL', 'invalid_url'],
        ['file:///tmp/private', 'unsupported_protocol'],
        ['javascript:alert(1)', 'unsupported_protocol'],
    ] as const)('rejects %s before confirmation or OS dispatch', async (url, reason) => {
        const target = dependencies();

        await expect(openExternalUrl(url, target)).resolves.toEqual({
            status: 'rejected',
            reason,
        });
        expect(target.confirm).not.toHaveBeenCalled();
        expect(target.open).not.toHaveBeenCalled();
    });

    it('returns canceled without dispatching the URL', async () => {
        const target = dependencies(false);

        await expect(openExternalUrl('https://example.com/path', target)).resolves.toEqual({
            status: 'canceled',
        });
        expect(target.confirm).toHaveBeenCalledOnce();
        expect(target.open).not.toHaveBeenCalled();
    });

    it('normalizes and dispatches a confirmed HTTP(S) URL exactly once', async () => {
        const target = dependencies();

        await expect(openExternalUrl('https://example.com/a b', target)).resolves.toEqual({
            status: 'opened',
        });
        expect(target.confirm).toHaveBeenCalledWith(new URL('https://example.com/a%20b'));
        expect(target.open).toHaveBeenCalledOnce();
        expect(target.open).toHaveBeenCalledWith('https://example.com/a%20b');
    });

    it('propagates an OS dispatch failure instead of reporting success', async () => {
        const target = dependencies();
        target.open.mockRejectedValueOnce(new Error('browser unavailable'));

        await expect(openExternalUrl('http://example.com', target)).rejects.toThrow(
            'browser unavailable',
        );
    });
});
