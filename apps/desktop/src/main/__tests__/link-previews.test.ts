import { describe, expect, it, vi } from 'vitest';

import { createLinkPreviews, parseLinkPreview } from '../link-previews';

/**
 * Every hostname resolves to a public documentation address, so only literal private hosts are refused.
 */
const publicHost = () => Promise.resolve(['203.0.113.7']);

/**
 * A plain-HTTP URL, built from an HTTPS one so a repository-wide insecure-URL rewrite cannot turn it back into HTTPS.
 */
function plainHttpUrl(): string {
    const url = new URL('https://b.example/');
    url.protocol = 'http:';
    return url.href;
}

function htmlResponse(body: string, contentType = 'text/html; charset=utf-8'): Promise<Response> {
    return Promise.resolve(
        new Response(body, { status: 200, headers: { 'content-type': contentType } }),
    );
}

describe('parseLinkPreview', () => {
    it('prefers Open Graph tags and resolves a relative image against the page', () => {
        const html = `<html><head>
            <title>Fallback</title>
            <meta property="og:title" content="Your Chief Agent Operator &middot; LobeHub &amp; more">
            <meta content='The ultimate space' property='og:description'>
            <meta property="og:image" content="/og.png">
        </head><body><meta property="og:title" content="ignored"></body></html>`;
        expect(parseLinkPreview(html, 'https://example.com/page')).toEqual({
            title: 'Your Chief Agent Operator \u{B7} LobeHub & more',
            description: 'The ultimate space',
            imageUrl: 'https://example.com/og.png',
        });
    });

    it('falls back to Twitter Card tags, then the title tag and description meta', () => {
        expect(
            parseLinkPreview(
                '<head><meta name="twitter:image" content="https://cdn.example/x.png"><title> A\n  page </title><meta name="description" content="Plain"></head>',
                'https://example.com',
            ),
        ).toEqual({ title: 'A page', description: 'Plain', imageUrl: 'https://cdn.example/x.png' });
    });

    it('drops an image that is not HTTPS and a page that declares nothing', () => {
        expect(
            parseLinkPreview(
                '<head><meta property="og:image" content="data:image/png;base64,AA=="></head>',
                'https://example.com',
            ),
        ).toEqual({});
    });
});

describe('createLinkPreviews', () => {
    it('reads each URL once and answers an empty preview for non-HTML', async () => {
        const fetch = vi.fn((url: string) =>
            url.endsWith('.zip')
                ? htmlResponse('PK', 'application/zip')
                : htmlResponse('<head><meta property="og:title" content="Hi"></head>'),
        );
        const preview = createLinkPreviews(fetch, publicHost);
        await expect(preview('https://a.example/')).resolves.toEqual({ title: 'Hi' });
        await preview('https://a.example/');
        expect(fetch).toHaveBeenCalledOnce();
        await expect(preview('https://a.example/file.zip')).resolves.toEqual({});
    });

    it('answers an empty preview when the request fails, and retries it on the next hover', async () => {
        const fetch = vi
            .fn<(url: string) => Promise<Response>>()
            .mockRejectedValueOnce(new Error('offline'))
            .mockImplementation(() => htmlResponse('<head><title>Back</title></head>'));
        const preview = createLinkPreviews(fetch, publicHost);
        await expect(preview('https://a.example/')).resolves.toEqual({});
        await expect(preview('https://a.example/')).resolves.toEqual({ title: 'Back' });
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('never requests a loopback, private, or internally resolving URL', async () => {
        const fetch = vi.fn(() => htmlResponse('<head><title>Admin</title></head>'));
        const preview = createLinkPreviews(fetch, (hostname) =>
            Promise.resolve(hostname === 'intranet.example' ? ['10.1.2.3'] : ['203.0.113.7']),
        );
        for (const url of [
            'https://127.0.0.1/reset?token=1',
            'https://192.168.0.1/admin/reboot',
            'https://intranet.example/',
        ]) {
            // eslint-disable-next-line no-await-in-loop -- each refusal is checked in turn
            await expect(preview(url)).resolves.toEqual({});
        }
        expect(fetch).not.toHaveBeenCalled();
    });

    it('follows a public redirect and resolves the share image against the final page', async () => {
        const fetch = vi.fn((url: string) =>
            url === 'https://a.example/short'
                ? Promise.resolve(
                      new Response(null, {
                          status: 301,
                          headers: { location: 'https://b.example/post/1' },
                      }),
                  )
                : htmlResponse('<head><meta property="og:image" content="/og.png"></head>'),
        );
        const preview = createLinkPreviews(fetch, publicHost);
        await expect(preview('https://a.example/short')).resolves.toEqual({
            imageUrl: 'https://b.example/og.png',
        });
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it.each([
        ['an internal address', 'https://169.254.169.254/latest/meta-data'],
        ['plain HTTP', plainHttpUrl()],
    ])('refuses a redirect to %s without requesting it', async (_label, location) => {
        const fetch = vi.fn(() =>
            Promise.resolve(new Response(null, { status: 307, headers: { location } })),
        );
        const preview = createLinkPreviews(fetch, publicHost);
        await expect(preview('https://a.example/')).resolves.toEqual({});
        expect(fetch).toHaveBeenCalledOnce();
    });
});
