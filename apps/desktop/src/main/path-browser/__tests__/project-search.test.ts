import { realpath } from 'node:fs/promises';
import { join } from 'node:path';

import type { MethodResult } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import type { vi } from 'vitest';
import { describe, expect, it } from 'vitest';

import {
    authorityOptions,
    bootstrap,
    fakeLogger,
    registerTemporaryDirectories,
} from './authority.fixture';

const temporaryDirectory = registerTemporaryDirectories();

interface BrowseResult {
    entries: Array<{ kind: 'directory' | 'file'; name: string; path: string }>;
    truncated: boolean;
}

describe('path browser Project-wide name search', () => {
    async function searchFixture(
        searchResult: (query: string) => unknown,
        options: {
            browse?: BrowseResult;
            logger?: ReturnType<typeof fakeLogger>;
            root?: string;
        } = {},
    ): Promise<{
        browse: (input: string) => Promise<MethodResult<'pathBrowser.browse'>>;
        request: ReturnType<typeof vi.fn>;
    }> {
        const workbenchRoot =
            options.root ?? (await realpath(await temporaryDirectory('caxri-path-search-')));
        const { authority, request } = authorityOptions(workbenchRoot, workbenchRoot, {
            logger: options.logger,
            request(method, parameters) {
                if (method === 'app.bootstrap')
                    return Promise.resolve(bootstrap(workbenchRoot, workbenchRoot));
                if (method === 'files.browse')
                    return Promise.resolve(options.browse ?? { entries: [], truncated: false });
                if (method === 'files.search')
                    return Promise.resolve(searchResult((parameters as { query: string }).query));
                return Promise.reject(new Error(`Unexpected method: ${method}`));
            },
        });
        const initial = await authority.start({ sessionId: 'session-1' });
        return {
            browse: (input) =>
                authority.browse({ browserId: initial.browserId, mode: 'project', input }),
            request,
        };
    }

    it('runs both lookups for a bare name and says which one produced each row', async () => {
        const root = await realpath(await temporaryDirectory('caxri-path-search-both-'));
        const { browse, request } = await searchFixture(
            () => ({
                matches: [{ path: join(root, 'src/app-menu.ts'), relativePath: 'src/app-menu.ts' }],
                canceled: false,
                truncated: false,
            }),
            {
                browse: {
                    entries: [{ kind: 'file', name: 'app.ts', path: join(root, 'app.ts') }],
                    truncated: false,
                },
                root,
            },
        );

        const listed = await browse('app');

        // The listed directory comes first: it is what the user navigated to, and the search only fills what is left.
        expect(listed.entries).toEqual([
            expect.objectContaining({ name: 'app.ts', source: 'directory' }),
            expect.objectContaining({
                directoryLabel: 'src',
                name: 'app-menu.ts',
                source: 'projectSearch',
            }),
        ]);
        expect(listed.projectSearch).toBe('complete');
        expect(request).toHaveBeenCalledWith('files.browse', expect.anything());
        expect(request).toHaveBeenCalledWith(
            'files.search',
            expect.objectContaining({ consumer: 'path-browser', mode: 'name', query: 'app' }),
        );
    });

    it('lists Project-wide name hits with their own directory when the directory has none', async () => {
        const root = await realpath(await temporaryDirectory('caxri-path-search-hit-'));
        const { browse } = await searchFixture(
            () => ({
                matches: [
                    {
                        path: join(root, 'a/b/resolveSafeMaxTokens.test.ts'),
                        relativePath: 'a/b/resolveSafeMaxTokens.test.ts',
                    },
                    {
                        path: join(root, 'a/b/resolveSafeMaxTokens.ts'),
                        relativePath: 'a/b/resolveSafeMaxTokens.ts',
                    },
                ],
                canceled: false,
                truncated: false,
            }),
            { root },
        );

        const listed = await browse('resolveSafeMaxTokens');

        expect(listed.entries).toEqual([
            expect.objectContaining({
                directoryLabel: 'a/b',
                kind: 'file',
                name: 'resolveSafeMaxTokens.ts',
                source: 'projectSearch',
            }),
            expect.objectContaining({
                directoryLabel: 'a/b',
                kind: 'file',
                name: 'resolveSafeMaxTokens.test.ts',
                source: 'projectSearch',
            }),
        ]);
    });

    it('shows a file the listed directory already holds once, not in both groups', async () => {
        const root = await realpath(await temporaryDirectory('caxri-path-search-dedupe-'));
        const { browse } = await searchFixture(
            () => ({
                matches: [
                    { path: join(root, 'kept.ts'), relativePath: 'kept.ts' },
                    { path: join(root, 'a/kept.ts'), relativePath: 'a/kept.ts' },
                ],
                canceled: false,
                truncated: false,
            }),
            {
                browse: {
                    entries: [{ kind: 'file', name: 'kept.ts', path: join(root, 'kept.ts') }],
                    truncated: false,
                },
                root,
            },
        );

        const listed = await browse('kept');

        expect(listed.entries).toEqual([
            expect.objectContaining({ name: 'kept.ts', source: 'directory' }),
            expect.objectContaining({
                directoryLabel: 'a',
                name: 'kept.ts',
                source: 'projectSearch',
            }),
        ]);
    });

    it('drops a searched path outside the browser root instead of minting an entry for it', async () => {
        const root = await realpath(await temporaryDirectory('caxri-path-search-escape-'));
        const outside = await realpath(await temporaryDirectory('caxri-path-search-outside-'));
        const { browse } = await searchFixture(
            () => ({
                matches: [
                    { path: join(outside, 'secret.ts'), relativePath: '../secret.ts' },
                    { path: join(root, 'kept.ts'), relativePath: 'kept.ts' },
                ],
                canceled: false,
                truncated: false,
            }),
            { root },
        );

        const listed = await browse('s');

        expect(listed.entries.map((entry) => entry.name)).toEqual(['kept.ts']);
    });

    it('labels a hit from the path it validated rather than the directory Server reported', async () => {
        const root = await realpath(await temporaryDirectory('caxri-path-search-label-'));
        const { browse } = await searchFixture(
            () => ({
                matches: [
                    // A Server that mislabels an in-root hit must not put its string on the row.
                    { path: join(root, 'a/b/kept.ts'), relativePath: '../elsewhere/kept.ts' },
                ],
                canceled: false,
                truncated: false,
            }),
            { root },
        );

        const listed = await browse('kept');

        expect(listed.entries).toEqual([
            expect.objectContaining({ directoryLabel: 'a/b', name: 'kept.ts' }),
        ]);
    });

    it('reports a canceled scan as incomplete instead of as a name that exists nowhere', async () => {
        const { browse } = await searchFixture(() => ({
            matches: [],
            canceled: true,
            truncated: false,
        }));

        const listed = await browse('resolveSafeMaxTokens');

        expect(listed.projectSearch).toBe('incomplete');
        expect(listed.entries).toEqual([]);
        // Only the directory listing may claim truncation; how far the scan got travels on its own field.
        expect(listed.truncated).toBe(false);
    });

    it('refines a completed scan locally instead of searching again for a longer name', async () => {
        const root = await realpath(await temporaryDirectory('caxri-path-search-memo-'));
        const { browse, request } = await searchFixture(
            () => ({
                matches: [
                    {
                        path: join(root, 'a/resolveSafeMaxTokens.ts'),
                        relativePath: 'a/resolveSafeMaxTokens.ts',
                    },
                    { path: join(root, 'a/resolveTheme.ts'), relativePath: 'a/resolveTheme.ts' },
                ],
                canceled: false,
                truncated: false,
            }),
            { root },
        );

        await browse('resolve');
        const refined = await browse('resolveSafe');

        expect(refined.entries.map((entry) => entry.name)).toEqual(['resolveSafeMaxTokens.ts']);
        expect(refined.projectSearch).toBe('complete');
        expect(request.mock.calls.filter(([method]) => method === 'files.search')).toHaveLength(1);
    });

    it('never refines an incomplete scan, whose misses prove nothing about the Project', async () => {
        const root = await realpath(await temporaryDirectory('caxri-path-search-partial-'));
        const { browse, request } = await searchFixture(
            () => ({
                matches: [{ path: join(root, 'a/resolve.ts'), relativePath: 'a/resolve.ts' }],
                canceled: false,
                truncated: true,
            }),
            { root },
        );

        const first = await browse('resolve');
        await browse('resolveSafe');

        expect(first.projectSearch).toBe('incomplete');
        expect(request.mock.calls.filter(([method]) => method === 'files.search')).toHaveLength(2);
    });

    it('keeps an input carrying a separator on the existing path behavior', async () => {
        const { browse, request } = await searchFixture(() => {
            throw new Error('files.search must not run for an explicit path');
        });

        const listed = await browse('./missing');

        expect(listed.projectSearch).toBe('skipped');
        expect(listed.entries).toEqual([]);
        expect(request).not.toHaveBeenCalledWith('files.search', expect.anything());
    });

    it('keeps the authoritative listing and says so when the search engine is unavailable', async () => {
        const { browse } = await searchFixture(() => {
            throw new CaxriError('UNAVAILABLE', 'Project search engine is unavailable');
        });

        const listed = await browse('anything');

        expect(listed.projectSearch).toBe('unavailable');
        expect(listed.entries).toEqual([]);
        expect(listed.truncated).toBe(false);
    });

    it('logs a closed reason enum, never the query, when the search engine cannot start', async () => {
        const logger = fakeLogger();
        const { browse } = await searchFixture(
            () => {
                throw new CaxriError('UNAVAILABLE', 'Project search engine is unavailable');
            },
            { logger },
        );

        const listed = await browse('anything');

        expect(listed.projectSearch).toBe('unavailable');
        expect(listed.entries).toEqual([]);
        const [level, event, options] = logger.calls.at(-1)!;
        expect(level).toBe('warn');
        expect(event).toBe('path_browser.search_failed');
        expect(options.fields).toEqual({ reason: 'unavailable' });
        expect(typeof options.durationMs).toBe('number');
        expect(JSON.stringify(options)).not.toContain('anything');
    });

    it('maps an IO failure and a lost connection to their own reason instead of one bucket', async () => {
        const io = fakeLogger();
        await (
            await searchFixture(
                () => {
                    throw new CaxriError('IO', 'Project root changed during search');
                },
                { logger: io },
            )
        ).browse('a');
        expect(io.calls.at(-1)![2].fields).toEqual({ reason: 'io' });

        const disconnected = fakeLogger();
        await (
            await searchFixture(
                () => {
                    throw new CaxriError(
                        'CANCELLED',
                        'Desktop Host connection is no longer active',
                    );
                },
                { logger: disconnected },
            )
        ).browse('a');
        expect(disconnected.calls.at(-1)![2].fields).toEqual({ reason: 'disconnected' });

        const other = fakeLogger();
        await (
            await searchFixture(
                () => {
                    throw new Error('boom');
                },
                { logger: other },
            )
        ).browse('a');
        expect(other.calls.at(-1)![2].fields).toEqual({ reason: 'other' });
    });

    it('logs the fallback outcome with memo/root-check/budget metrics on a normal run', async () => {
        const root = await realpath(await temporaryDirectory('caxri-path-search-log-'));
        const outside = await realpath(await temporaryDirectory('caxri-path-search-log-outside-'));
        const logger = fakeLogger();
        const { browse } = await searchFixture(
            () => ({
                matches: [
                    { path: join(root, 'a/kept.ts'), relativePath: 'a/kept.ts' },
                    { path: join(outside, 'dropped.ts'), relativePath: '../dropped.ts' },
                ],
                canceled: false,
                truncated: false,
            }),
            { logger, root },
        );

        await browse('kept');

        const fresh = logger.calls.at(-1)!;
        expect(fresh[0]).toBe('debug');
        expect(fresh[1]).toBe('path_browser.search_fallback');
        expect(fresh[2].fields).toEqual({
            memoHit: false,
            matchCount: 2,
            droppedByRootCheck: 1,
            displayedCount: 1,
            truncated: false,
            canceled: false,
        });
        expect(typeof fresh[2].durationMs).toBe('number');

        // A second, longer filter refines the memoized result instead of asking Server again.
        await browse('kept.t');
        const memoized = logger.calls.at(-1)!;
        expect(memoized[2].fields).toMatchObject({ memoHit: true, matchCount: 1 });
    });

    it('still searches the Project when the directory listing itself was truncated', async () => {
        const root = await realpath(await temporaryDirectory('caxri-path-search-trunc-'));
        const { browse, request } = await searchFixture(
            () => ({
                matches: [{ path: join(root, 'a/name-here.ts'), relativePath: 'a/name-here.ts' }],
                canceled: false,
                truncated: false,
            }),
            {
                browse: {
                    entries: [{ kind: 'file', name: 'name.ts', path: join(root, 'name.ts') }],
                    truncated: true,
                },
                root,
            },
        );

        const listed = await browse('name');

        // A truncated directory is the strongest case for the Project-wide group: what the user wants may be the part
        // that was cut off.
        expect(listed.truncated).toBe(true);
        expect(listed.entries.map((entry) => entry.source)).toEqual(['directory', 'projectSearch']);
        expect(request).toHaveBeenCalledWith('files.search', expect.anything());
    });
});
