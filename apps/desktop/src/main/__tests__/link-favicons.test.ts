import { describe, expect, it, vi } from 'vitest';

import { createLinkFavicons } from '../link-favicons';

/**
 * Every hostname resolves to a public documentation address, so only literal private hosts are refused.
 */
const publicHost = () => Promise.resolve(['203.0.113.7']);

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
        const favicon = createLinkFavicons(fetch, publicHost);
        await expect(favicon('https://a.example')).resolves.toEqual({
            dataUrl: 'data:image/png;base64,AQID',
        });
        await favicon('https://a.example');
        expect(fetch).toHaveBeenCalledOnce();
        expect(fetch).toHaveBeenCalledWith('https://a.example/favicon.ico', expect.anything());
    });

    it('reads a named icon path on the origin and caches it apart from the favicon', async () => {
        const fetch = vi.fn<(url: string) => ReturnType<typeof iconResponse>>(() =>
            iconResponse(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } }),
        );
        const favicon = createLinkFavicons(fetch, publicHost);
        await favicon('https://a.example', '/images/icon-32.png');
        await favicon('https://a.example', '/images/icon-32.png');
        await favicon('https://a.example');
        expect(fetch.mock.calls.map(([url]) => url)).toEqual([
            'https://a.example/images/icon-32.png',
            'https://a.example/favicon.ico',
        ]);
    });

    it('labels an untyped body as an icon', async () => {
        const favicon = createLinkFavicons(() => iconResponse(new Uint8Array([7])), publicHost);
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
        const favicon = createLinkFavicons(fetch, publicHost);
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
        const favicon = createLinkFavicons(
            () =>
                iconResponse(body as unknown as string, {
                    headers: { 'content-type': 'image/png' },
                }),
            publicHost,
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
        const favicon = createLinkFavicons(
            () =>
                iconResponse(body as unknown as string, {
                    headers: { 'content-type': 'image/png' },
                }),
            publicHost,
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
        const favicon = createLinkFavicons(fetch, publicHost);
        await expect(favicon('https://a.example')).resolves.toEqual({});
        await expect(favicon('https://a.example')).resolves.toEqual({
            dataUrl: 'data:image/png;base64,AQID',
        });
        await favicon('https://a.example');
        expect(fetch).toHaveBeenCalledTimes(2);
    });
    it('keeps a newer cached attempt when an evicted failed attempt settles', async () => {
        const first = Promise.withResolvers<Response>();
        let isFirstAsked = false;
        const fetch = vi.fn((url: string) => {
            if (url === 'https://a.example/favicon.ico' && !isFirstAsked) {
                isFirstAsked = true;
                return first.promise;
            }
            return iconResponse(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } });
        });
        const favicon = createLinkFavicons(fetch, publicHost);
        const stale = favicon('https://a.example');
        // Fill the cache past its bound so the pending attempt for a.example is evicted, then ask again.
        await Promise.all(
            Array.from({ length: 256 }, (_, index) => favicon(`https://${index}.example`)),
        );
        const fresh = await favicon('https://a.example');
        first.reject(new Error('offline'));
        await expect(stale).resolves.toEqual({});
        await expect(favicon('https://a.example')).resolves.toBe(fresh);
        expect(
            fetch.mock.calls.filter(([url]) => url === 'https://a.example/favicon.ico'),
        ).toHaveLength(2);
    });

    it.each([
        'https://127.0.0.1',
        'https://localhost:8443',
        'https://192.168.1.1',
        'https://[::1]',
    ])('never requests the icon of the internal origin %s', async (origin) => {
        const fetch = vi.fn(() => iconResponse(new Uint8Array([1])));
        const favicon = createLinkFavicons(fetch, publicHost);
        await expect(favicon(origin)).resolves.toEqual({});
        expect(fetch).not.toHaveBeenCalled();
    });

    it('stops at a redirect to an internal address and keeps the globe', async () => {
        const fetch = vi.fn((url: string) =>
            Promise.resolve(
                url === 'https://a.example/favicon.ico'
                    ? new Response(null, {
                          status: 302,
                          headers: { location: 'https://10.0.0.8/favicon.ico' },
                      })
                    : new Response(new Uint8Array([1]), {
                          headers: { 'content-type': 'image/png' },
                      }),
            ),
        );
        const favicon = createLinkFavicons(fetch, publicHost);
        await expect(favicon('https://a.example')).resolves.toEqual({});
        expect(fetch).toHaveBeenCalledOnce();
    });
});
