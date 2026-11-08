import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    assetUrl,
    releaseFetch,
    releasePageRedirect,
    removeTemporaryDirectories,
    temporaryDirectory,
} from '../../__tests__/support/update-service-harness';
import {
    LATEST_RELEASE_PAGE_URL,
    LATEST_RELEASE_URL,
    parseLatestReleaseRedirect,
} from '../update-github-release';
import { UpdateService } from '../updates';

afterEach(removeTemporaryDirectories);

describe('when the releases API is rate limited', () => {
    const nowMs = 1_700_000_000_000;
    const resetEpochSeconds = Math.floor(nowMs / 1_000) + 600;
    const apiLimited = () =>
        new Response(null, {
            status: 403,
            headers: { 'x-ratelimit-reset': String(resetEpochSeconds) },
        });
    const isApi = (input: string) => input === LATEST_RELEASE_URL;
    const isPage = (input: string) => input === LATEST_RELEASE_PAGE_URL;

    it('finds and downloads the release through the release page redirect', async () => {
        const directory = await temporaryDirectory();
        const dmg = new TextEncoder().encode('dmg fixture');
        const serve = releaseFetch('0.0.4', dmg);
        const fetch = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>((input) =>
            isApi(input) ? Promise.resolve(apiLimited()) : serve(input),
        );
        const service = new UpdateService({
            currentVersion: '0.0.3',
            downloadDirectory: directory,
            enabled: true,
            fetch,
            now: () => nowMs,
            openPath: () => Promise.resolve(''),
        });

        await expect(service.check()).resolves.toMatchObject({
            status: 'available',
            version: '0.0.4',
            releaseUrl: 'https://github.com/tjx666/caxri/releases/tag/v0.0.4',
        });
        // Reads only the redirect: following it would download the release page HTML.
        expect(fetch.mock.calls.find(([input]) => isPage(input))?.[1]).toMatchObject({
            method: 'HEAD',
            redirect: 'manual',
        });
        await expect(service.download()).resolves.toMatchObject({ status: 'ready' });
        expect(fetch).toHaveBeenCalledWith(
            assetUrl('0.0.4', 'Caxri-0.0.4-arm64.dmg'),
            expect.anything(),
        );

        // Inside the recorded window the next check skips the API and asks the page directly.
        fetch.mockClear();
        await service.check({ background: true });
        expect(fetch.mock.calls.map(([input]) => input)).toEqual([LATEST_RELEASE_PAGE_URL]);
    });

    it('reports up to date through the page when no newer release exists', async () => {
        const directory = await temporaryDirectory();
        const fetch = vi.fn((input: string): Promise<Response> =>
            Promise.resolve(isApi(input) ? apiLimited() : releasePageRedirect('0.0.3')),
        );
        const service = new UpdateService({
            currentVersion: '0.0.3',
            downloadDirectory: directory,
            enabled: true,
            fetch,
            now: () => nowMs,
            openPath: () => Promise.resolve(''),
        });

        await expect(service.check()).resolves.toMatchObject({ status: 'up-to-date' });
    });

    it('degrades to rate-limited with the reset time only when the page fails too', async () => {
        const directory = await temporaryDirectory();
        const fetch = vi.fn((input: string): Promise<Response> =>
            Promise.resolve(isApi(input) ? apiLimited() : new Response(null, { status: 429 })),
        );
        const service = new UpdateService({
            currentVersion: '0.0.3',
            downloadDirectory: directory,
            enabled: true,
            fetch,
            now: () => nowMs,
            openPath: () => Promise.resolve(''),
        });

        // The resume time reaches the Renderer instead of being computed and dropped: it is what turns an
        // unexplained failure into a wait the user can plan around.
        await expect(service.check()).resolves.toEqual({
            status: 'unavailable',
            currentVersion: '0.0.3',
            reason: 'rate-limited',
            retryAt: resetEpochSeconds * 1_000,
        });
        // Checking again inside the window asks only the page; the API is not hit again.
        fetch.mockClear();
        await expect(service.check()).resolves.toMatchObject({ reason: 'rate-limited' });
        expect(fetch.mock.calls.map(([input]) => input)).toEqual([LATEST_RELEASE_PAGE_URL]);
    });

    it('rejects a page redirect that does not name a release tag of this repository', async () => {
        const directory = await temporaryDirectory();
        const fetch = vi.fn((input: string): Promise<Response> =>
            Promise.resolve(
                isApi(input)
                    ? apiLimited()
                    : new Response(null, {
                          status: 302,
                          headers: { location: 'https://github.com/login' },
                      }),
            ),
        );
        const service = new UpdateService({
            currentVersion: '0.0.3',
            downloadDirectory: directory,
            enabled: true,
            fetch,
            now: () => nowMs,
            openPath: () => Promise.resolve(''),
        });

        await expect(service.check()).resolves.toMatchObject({
            status: 'unavailable',
            reason: 'rate-limited',
        });
    });

    it('uses retry-after for a secondary limit', async () => {
        const directory = await temporaryDirectory();
        const fetch = vi.fn((input: string): Promise<Response> =>
            Promise.resolve(
                new Response(null, {
                    status: 429,
                    headers: isApi(input) ? { 'retry-after': '30' } : {},
                }),
            ),
        );
        const service = new UpdateService({
            currentVersion: '0.0.3',
            downloadDirectory: directory,
            enabled: true,
            fetch,
            now: () => nowMs,
            openPath: () => Promise.resolve(''),
        });

        await expect(service.check()).resolves.toMatchObject({
            reason: 'rate-limited',
            retryAt: nowMs + 30_000,
        });
    });

    it('keeps an available offer through a background check that GitHub fully limits', async () => {
        const directory = await temporaryDirectory();
        const succeed = releaseFetch('0.0.4', new TextEncoder().encode('dmg fixture'));
        const fetch = vi.fn((input: string): Promise<Response> =>
            fetch.mock.calls.length === 1
                ? succeed(input)
                : Promise.resolve(
                      isApi(input) ? apiLimited() : new Response(null, { status: 429 }),
                  ),
        );
        const service = new UpdateService({
            currentVersion: '0.0.3',
            downloadDirectory: directory,
            enabled: true,
            fetch,
            now: () => nowMs,
            openPath: () => Promise.resolve(''),
        });

        expect((await service.check()).status).toBe('available');
        expect((await service.check({ background: true })).status).toBe('available');
        expect((await service.check({ background: true })).status).toBe('available');
        expect(service.getState().status).toBe('available');
    });

    it('asks the API again once the window has elapsed', async () => {
        const directory = await temporaryDirectory();
        let now = nowMs;
        const succeed = releaseFetch('0.0.4', new TextEncoder().encode('dmg fixture'));
        let isLimited = true;
        const fetch = vi.fn((input: string): Promise<Response> =>
            isLimited && isApi(input) ? Promise.resolve(apiLimited()) : succeed(input),
        );
        const service = new UpdateService({
            currentVersion: '0.0.3',
            downloadDirectory: directory,
            enabled: true,
            fetch,
            now: () => now,
            openPath: () => Promise.resolve(''),
        });

        await service.check();
        isLimited = false;
        now = resetEpochSeconds * 1_000 + 1;
        fetch.mockClear();
        await expect(service.check()).resolves.toMatchObject({ status: 'available' });
        expect(fetch.mock.calls.map(([input]) => input)).toEqual([LATEST_RELEASE_URL]);
    });
});

describe('parseLatestReleaseRedirect', () => {
    const tag = (version: string) => `https://github.com/tjx666/caxri/releases/tag/v${version}`;

    it('derives the exact asset URLs of the redirected tag', () => {
        expect(parseLatestReleaseRedirect(tag('0.0.4'), '0.0.3', 'omit')).toEqual({
            version: '0.0.4',
            fileName: 'Caxri-0.0.4-arm64-nosourcemap.dmg',
            dmgUrl: assetUrl('0.0.4', 'Caxri-0.0.4-arm64-nosourcemap.dmg'),
            checksumUrl: assetUrl('0.0.4', 'Caxri-0.0.4-arm64-nosourcemap.dmg.sha256'),
            releaseUrl: tag('0.0.4'),
        });
    });

    it('returns nothing for a release that is not newer', () => {
        expect(parseLatestReleaseRedirect(tag('0.0.3'), '0.0.3', 'include')).toBeUndefined();
    });

    it.each([
        ['no location', null],
        ['another host', 'https://evil.example/tjx666/caxri/releases/tag/v0.0.4'],
        ['another repository', 'https://github.com/other/repo/releases/tag/v0.0.4'],
        ['the releases index', 'https://github.com/tjx666/caxri/releases'],
        ['a non-stable tag', tag('0.0.4-beta.1')],
    ])('rejects %s', (_label, location) => {
        expect(() => parseLatestReleaseRedirect(location, '0.0.3', 'include')).toThrow();
    });
});
