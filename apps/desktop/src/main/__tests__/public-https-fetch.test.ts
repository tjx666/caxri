import { describe, expect, it, vi } from 'vitest';

import { createPublicHttpsFetch, isPublicAddress } from '../public-https-fetch';

const init = { signal: new AbortController().signal };

function redirect(location: string, status = 302): Promise<Response> {
    return Promise.resolve(new Response(null, { status, headers: { location } }));
}

describe('isPublicAddress', () => {
    it.each([
        '127.0.0.1',
        '10.2.3.4',
        '172.20.0.1',
        '192.168.1.1',
        '169.254.169.254',
        '100.100.100.100',
        '0.0.0.0',
        '::1',
        '::',
        'fd12::1',
        'fe80::1',
        '::ffff:127.0.0.1',
        '::ffff:c0a8:101',
        'not-an-ip',
    ])('refuses %s', (address) => {
        expect(isPublicAddress(address)).toBe(false);
    });

    it.each(['203.0.113.7', '8.8.8.8', '198.18.0.5', '2606:4700::1111'])(
        'accepts %s',
        (address) => {
            expect(isPublicAddress(address)).toBe(true);
        },
    );
});

describe('createPublicHttpsFetch', () => {
    it('returns the final response and URL after public redirects', async () => {
        const fetch = vi.fn((url: string) =>
            url === 'https://a.example/'
                ? redirect('/next', 301)
                : Promise.resolve(new Response('ok')),
        );
        const publicFetch = createPublicHttpsFetch(fetch, () => Promise.resolve(['203.0.113.7']));
        const result = await publicFetch('https://a.example/', init);
        expect(result?.url).toBe('https://a.example/next');
        await expect(result?.response.text()).resolves.toBe('ok');
    });

    it('refuses a hostname when any resolved address is internal', async () => {
        const fetch = vi.fn(() => Promise.resolve(new Response('ok')));
        const publicFetch = createPublicHttpsFetch(fetch, () =>
            Promise.resolve(['203.0.113.7', '127.0.0.1']),
        );
        await expect(publicFetch('https://rebind.example/', init)).resolves.toBeUndefined();
        expect(fetch).not.toHaveBeenCalled();
    });

    it('requests a hostname the local resolver cannot resolve, as a proxy may resolve it', async () => {
        const fetch = vi.fn(() => Promise.resolve(new Response('ok')));
        const publicFetch = createPublicHttpsFetch(fetch, () =>
            Promise.reject(new Error('net::ERR_NAME_NOT_RESOLVED')),
        );
        const result = await publicFetch('https://a.example/', init);
        expect(fetch).toHaveBeenCalledWith('https://a.example/', init);
        await expect(result?.response.text()).resolves.toBe('ok');
    });

    it('still refuses localhost and internal literals when lookups fail', async () => {
        const fetch = vi.fn(() => Promise.resolve(new Response('ok')));
        const resolveHost = vi.fn(() => Promise.reject(new Error('net::ERR_NAME_NOT_RESOLVED')));
        const publicFetch = createPublicHttpsFetch(fetch, resolveHost);
        await expect(publicFetch('https://app.localhost/', init)).resolves.toBeUndefined();
        await expect(publicFetch('https://127.0.0.1/', init)).resolves.toBeUndefined();
        expect(fetch).not.toHaveBeenCalled();
        expect(resolveHost).not.toHaveBeenCalled();
    });

    it('rejects when the request itself fails, so the caller can retry', async () => {
        const fetch = vi.fn(() => Promise.reject(new Error('net::ERR_INTERNET_DISCONNECTED')));
        const publicFetch = createPublicHttpsFetch(fetch, () =>
            Promise.reject(new Error('net::ERR_NAME_NOT_RESOLVED')),
        );
        await expect(publicFetch('https://a.example/', init)).rejects.toThrow('DISCONNECTED');
    });

    it('gives up after too many redirects', async () => {
        let hop = 0;
        const fetch = vi.fn(() => redirect(`https://a.example/${(hop += 1)}`));
        const publicFetch = createPublicHttpsFetch(fetch, () => Promise.resolve(['203.0.113.7']));
        await expect(publicFetch('https://a.example/', init)).resolves.toBeUndefined();
        expect(fetch).toHaveBeenCalledTimes(6);
    });
});
