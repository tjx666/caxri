import { describe, expect, it, vi } from 'vitest';

import { createLinkPreviews, parseLinkPreview } from '../link-previews';

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
        const preview = createLinkPreviews(fetch);
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
        const preview = createLinkPreviews(fetch);
        await expect(preview('https://a.example/')).resolves.toEqual({});
        await expect(preview('https://a.example/')).resolves.toEqual({ title: 'Back' });
        expect(fetch).toHaveBeenCalledTimes(2);
    });
});
