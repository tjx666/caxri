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
        ['a network failure', () => Promise.reject(new TypeError('offline'))],
    ])('answers no icon for %s, and remembers that', async (_label, respond) => {
        const fetch = vi.fn(respond);
        const favicon = createLinkFavicons(fetch);
        await expect(favicon('https://a.example')).resolves.toEqual({});
        await expect(favicon('https://a.example')).resolves.toEqual({});
        expect(fetch).toHaveBeenCalledOnce();
    });
});
