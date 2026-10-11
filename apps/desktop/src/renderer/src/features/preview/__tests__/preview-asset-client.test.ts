import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.fn<(...parameters: unknown[]) => Promise<unknown>>();
vi.mock('../../../lib/caxri', () => ({
    caxri: { request: (...parameters: unknown[]) => request(...parameters) },
}));

const { acquireAsset, releaseAsset } = await import('../preview-asset-client');

const PIXEL = 'R0lGODlhAQABAAAAACw=';

/**
 * `Uint8Array.prototype.toBase64` is a Renderer API the Node runtime these tests execute under does not have, and the
 * Renderer may not import Node builtins, so neither it nor `Buffer` is available here. `btoa` takes a string, and
 * spreading a multi-megabyte asset into `String.fromCodePoint` at once overflows the argument list.
 */
function encodeBase64(bytes: Uint8Array): string {
    const chunkSize = 0x8000;
    let binary = '';
    for (let index = 0; index < bytes.length; index += chunkSize)
        binary += String.fromCodePoint(...bytes.subarray(index, index + chunkSize));
    return btoa(binary);
}

/**
 * Object URLs are the one thing in the preview whose lifetime the DOM does not manage for us: a revoked URL keeps
 * rendering as a broken image with no error anywhere, so every refcount path gets a test.
 */
describe('preview asset client', () => {
    let created: string[] = [];
    let revoked: string[] = [];
    let blobs: Blob[] = [];

    beforeEach(() => {
        created = [];
        revoked = [];
        blobs = [];
        request.mockReset();
        request.mockResolvedValue({
            path: '/p/logo.gif',
            mediaType: 'image/gif',
            base64: PIXEL,
            size: 8,
        });
        vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
            blobs.push(blob as Blob);
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

    it('bounds distinct image reads across concurrent preview consumers', async () => {
        const releaseReads = Promise.withResolvers<void>();
        let active = 0;
        let peak = 0;
        request.mockImplementation(async () => {
            active += 1;
            peak = Math.max(peak, active);
            await releaseReads.promise;
            active -= 1;
            return { path: '/p/image.gif', mediaType: 'image/gif', base64: PIXEL, size: 8 };
        });
        const paths = Array.from({ length: 32 }, (_, index) => `/p/image-${index}.gif`);
        const reads = paths.map((path) => acquireAsset({ sessionId: 'bounded-session' }, path));
        try {
            await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(4));
            expect(peak).toBe(4);
        } finally {
            releaseReads.resolve();
            await Promise.all(reads);
            for (const path of paths) releaseAsset({ sessionId: 'bounded-session' }, path);
        }
        expect(peak).toBe(4);
        expect(created).toHaveLength(32);
        expect(revoked).toHaveLength(32);
    });

    it('preserves every byte when decoding an asset at the read ceiling', async () => {
        const expected = new Uint8Array(8 * 1024 * 1024).fill(0xa5);
        expected[0] = 0;
        expected[expected.length - 1] = 0xff;
        request.mockResolvedValue({
            path: '/p/large.png',
            mediaType: 'image/png',
            base64: encodeBase64(expected),
            size: expected.byteLength,
        });
        try {
            await acquireAsset({ sessionId: 'large-session' }, '/p/large.png');
            const blob = blobs.at(-1) as Blob;
            expect(blob.type).toBe('image/png');
            const decoded = new Uint8Array(await blob.arrayBuffer());
            expect(decoded.byteLength).toBe(expected.byteLength);
            expect(decoded.every((value, index) => value === expected[index])).toBe(true);
        } finally {
            releaseAsset({ sessionId: 'large-session' }, '/p/large.png');
        }
    });

    it('reads one asset once and hands the same URL to both holders', async () => {
        const [first, second] = await Promise.all([
            acquireAsset({ sessionId: 's1' }, '/p/logo.gif'),
            acquireAsset({ sessionId: 's1' }, '/p/logo.gif'),
        ]);

        expect(request).toHaveBeenCalledTimes(1);
        expect(first).toBe(second);
        // The shared read resolves to one URL; revoking it for the second caller would blank the first caller's image.
        expect(revoked).toEqual([]);
        releaseAsset({ sessionId: 's1' }, '/p/logo.gif');
        releaseAsset({ sessionId: 's1' }, '/p/logo.gif');
    });

    it('keeps the URL alive until the last holder releases it', async () => {
        await acquireAsset({ sessionId: 's1' }, '/p/logo.gif');
        await acquireAsset({ sessionId: 's1' }, '/p/logo.gif');

        releaseAsset({ sessionId: 's1' }, '/p/logo.gif');
        expect(revoked).toEqual([]);
        releaseAsset({ sessionId: 's1' }, '/p/logo.gif');
        expect(revoked).toEqual(created);
    });

    it('re-reads after the last holder left', async () => {
        await acquireAsset({ sessionId: 's1' }, '/p/logo.gif');
        releaseAsset({ sessionId: 's1' }, '/p/logo.gif');
        const second = await acquireAsset({ sessionId: 's1' }, '/p/logo.gif');

        expect(request).toHaveBeenCalledTimes(2);
        expect(second).toBe(created[1]);
        releaseAsset({ sessionId: 's1' }, '/p/logo.gif');
    });

    it('keeps two Sessions reading the same path apart', async () => {
        const first = await acquireAsset({ sessionId: 's1' }, '/p/logo.gif');
        const second = await acquireAsset({ sessionId: 's2' }, '/p/logo.gif');

        expect(first).not.toBe(second);
        releaseAsset({ sessionId: 's1' }, '/p/logo.gif');
        expect(revoked).toEqual([first]);
        releaseAsset({ sessionId: 's2' }, '/p/logo.gif');
    });

    it('reports a failed read as no URL without caching it', async () => {
        request.mockRejectedValue(new Error('unauthorized'));

        expect(await acquireAsset({ sessionId: 's1' }, '/p/missing.png')).toBeUndefined();
        expect(created).toEqual([]);
        // Nothing was cached, so a later read is free to try again.
        request.mockResolvedValue({
            path: '/p/missing.png',
            mediaType: 'image/png',
            base64: PIXEL,
            size: 8,
        });
        expect(await acquireAsset({ sessionId: 's1' }, '/p/missing.png')).toBe(created[0]);
        releaseAsset({ sessionId: 's1' }, '/p/missing.png');
    });

    it('ignores a release for an asset it never handed out', () => {
        releaseAsset({ sessionId: 's1' }, '/p/never.png');

        expect(revoked).toEqual([]);
    });

    it('reads an external document image through Main with only the part below its folder', async () => {
        const source = { externalDocumentId: 'doc-1', directory: '/tmp/notes' };

        expect(await acquireAsset(source, '/tmp/notes/assets/logo.gif')).toBe(created[0]);
        expect(request).toHaveBeenCalledWith('externalDocument.readAsset', {
            documentId: 'doc-1',
            path: 'assets/logo.gif',
        });
        expect(await acquireAsset(source, '/tmp/other/logo.gif')).toBeUndefined();
        expect(request).toHaveBeenCalledTimes(1);
        releaseAsset(source, '/tmp/notes/assets/logo.gif');
        expect(revoked).toEqual([created[0]]);
    });
});
