import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.fn<(...parameters: unknown[]) => Promise<unknown>>();
vi.mock('../../../lib/caxri', () => ({
    caxri: { request: (...parameters: unknown[]) => request(...parameters) },
}));

const { acquireAsset, releaseAsset } = await import('../preview-asset-client');

const PIXEL = 'R0lGODlhAQABAAAAACw=';

/**
 * Object URLs are the one thing in the preview whose lifetime the DOM does not manage for us: a revoked URL keeps
 * rendering as a broken image with no error anywhere, so every refcount path gets a test.
 */
describe('preview asset client', () => {
    let created: string[] = [];
    let revoked: string[] = [];

    beforeEach(() => {
        created = [];
        revoked = [];
        request.mockReset();
        request.mockResolvedValue({
            path: '/p/logo.gif',
            mediaType: 'image/gif',
            base64: PIXEL,
            size: 8,
        });
        vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
            const url = `blob:test/${created.length + 1}`;
            created.push(url);
            return url;
        });
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => {
            revoked.push(url);
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('reads one asset once and hands the same URL to both holders', async () => {
        const [first, second] = await Promise.all([
            acquireAsset('s1', '/p/logo.gif'),
            acquireAsset('s1', '/p/logo.gif'),
        ]);

        expect(request).toHaveBeenCalledTimes(1);
        expect(first).toBe(second);
        // The shared read resolves to one URL; revoking it for the second caller would blank the first caller's image.
        expect(revoked).toEqual([]);
        releaseAsset('s1', '/p/logo.gif');
        releaseAsset('s1', '/p/logo.gif');
    });

    it('keeps the URL alive until the last holder releases it', async () => {
        await acquireAsset('s1', '/p/logo.gif');
        await acquireAsset('s1', '/p/logo.gif');

        releaseAsset('s1', '/p/logo.gif');
        expect(revoked).toEqual([]);
        releaseAsset('s1', '/p/logo.gif');
        expect(revoked).toEqual(created);
    });

    it('re-reads after the last holder left', async () => {
        await acquireAsset('s1', '/p/logo.gif');
        releaseAsset('s1', '/p/logo.gif');
        const second = await acquireAsset('s1', '/p/logo.gif');

        expect(request).toHaveBeenCalledTimes(2);
        expect(second).toBe(created[1]);
        releaseAsset('s1', '/p/logo.gif');
    });

    it('keeps two Sessions reading the same path apart', async () => {
        const first = await acquireAsset('s1', '/p/logo.gif');
        const second = await acquireAsset('s2', '/p/logo.gif');

        expect(first).not.toBe(second);
        releaseAsset('s1', '/p/logo.gif');
        expect(revoked).toEqual([first]);
        releaseAsset('s2', '/p/logo.gif');
    });

    it('reports a failed read as no URL without caching it', async () => {
        request.mockRejectedValue(new Error('unauthorized'));

        expect(await acquireAsset('s1', '/p/missing.png')).toBeUndefined();
        expect(created).toEqual([]);
        // Nothing was cached, so a later read is free to try again.
        request.mockResolvedValue({
            path: '/p/missing.png',
            mediaType: 'image/png',
            base64: PIXEL,
            size: 8,
        });
        expect(await acquireAsset('s1', '/p/missing.png')).toBe(created[0]);
        releaseAsset('s1', '/p/missing.png');
    });

    it('ignores a release for an asset it never handed out', () => {
        releaseAsset('s1', '/p/never.png');

        expect(revoked).toEqual([]);
    });
});
