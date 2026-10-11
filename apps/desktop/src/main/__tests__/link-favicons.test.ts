import { describe, expect, it, vi } from 'vitest';

import { createLinkFavicons } from '../link-favicons';

function iconResponse(
    body: Uint8Array<ArrayBuffer> | string,
    init: ResponseInit = {},
): Promise<Response> {
    return Promise.resolve(new Response(body, { status: 200, ...init }));
}

describe('createLinkFavicons', () => {
    it('returns the icon as a data URL and asks each origin once', async () => {
        const fetch = vi.fn(() =>
            iconResponse(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }),
        );
        const favicon = createLinkFavicons(fetch);
        await expect(favicon('https://a.example')).resolves.toEqual({
            dataUrl: 'data:image/png;base64,AQID',
        });
        await favicon('https://a.example');
        expect(fetch).toHaveBeenCalledOnce();
        expect(fetch).toHaveBeenCalledWith('https://a.example/favicon.ico', expect.anything());
    });

    it('labels an untyped body as an icon', async () => {
        const favicon = createLinkFavicons(() => iconResponse(new Uint8Array([7])));
        await expect(favicon('https://a.example')).resolves.toEqual({
            dataUrl: 'data:image/x-icon;base64,Bw==',
        });
    });

    it.each([
        ['a 404', () => iconResponse('missing', { status: 404 })],
        [
            'an HTML page served as the icon',
            () => iconResponse('<html></html>', { headers: { 'content-type': 'text/html' } }),
        ],
        [
            'an icon over the size bound',
            () =>
                iconResponse(new Uint8Array(40 * 1024), {
                    headers: { 'content-type': 'image/png' },
                }),
        ],
    ])('answers no icon for %s, and remembers that', async (_label, respond) => {
        const fetch = vi.fn(respond);
        const favicon = createLinkFavicons(fetch);
        await expect(favicon('https://a.example')).resolves.toEqual({});
        await expect(favicon('https://a.example')).resolves.toEqual({});
        expect(fetch).toHaveBeenCalledOnce();
    });

    it('stops reading an oversize body that declares no length', async () => {
        let pulls = 0;
        let isCancelled = false;
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                // A 256 KiB body with no content-length, as a chunked response sends it.
                if (pulls === 64) return controller.close();
                pulls += 1;
                controller.enqueue(new Uint8Array(4 * 1024));
            },
            cancel() {
                isCancelled = true;
            },
        });
        const favicon = createLinkFavicons(() =>
            iconResponse(body as unknown as string, { headers: { 'content-type': 'image/png' } }),
        );
        await expect(favicon('https://a.example')).resolves.toEqual({});
        expect(pulls).toBeLessThan(16);
        expect(isCancelled).toBe(true);
    });

    it('accepts an icon of exactly the size bound streamed in chunks', async () => {
        const chunk = new Uint8Array(8 * 1024);
        let sent = 0;
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                if (sent === 4) return controller.close();
                sent += 1;
                controller.enqueue(chunk);
            },
        });
        const favicon = createLinkFavicons(() =>
            iconResponse(body as unknown as string, { headers: { 'content-type': 'image/png' } }),
        );
        const result = await favicon('https://a.example');
        expect(result.dataUrl?.startsWith('data:image/png;base64,')).toBe(true);
    });

    it('asks again after a network failure instead of remembering it', async () => {
        const fetch = vi
            .fn<() => Promise<Response>>()
            .mockRejectedValueOnce(new TypeError('offline'))
            .mockImplementation(() =>
                iconResponse(new Uint8Array([1, 2, 3]), {
                    headers: { 'content-type': 'image/png' },
                }),
            );
        const favicon = createLinkFavicons(fetch);
        await expect(favicon('https://a.example')).resolves.toEqual({});
        await expect(favicon('https://a.example')).resolves.toEqual({
            dataUrl: 'data:image/png;base64,AQID',
        });
        await favicon('https://a.example');
        expect(fetch).toHaveBeenCalledTimes(2);
    });
});
