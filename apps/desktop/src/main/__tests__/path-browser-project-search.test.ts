import { realpath } from 'node:fs/promises';
import { join } from 'node:path';

import type { MethodResult } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import type { vi } from 'vitest';
import { describe, expect, it } from 'vitest';

import {
    authorityOptions,
    bootstrap,
    registerTemporaryDirectories,
} from './path-browser-authority.fixture';

const temporaryDirectory = registerTemporaryDirectories();

describe('path browser Project-wide name fallback', () => {
    async function searchFixture(
        searchResult: (query: string) => unknown,
        root?: string,
    ): Promise<{
        browse: (input: string) => Promise<MethodResult<'pathBrowser.browse'>>;
        request: ReturnType<typeof vi.fn>;
    }> {
        const workbenchRoot =
            root ?? (await realpath(await temporaryDirectory('caxri-path-search-')));
        const { authority, request } = authorityOptions(workbenchRoot, workbenchRoot, {
            request(method, parameters) {
                if (method === 'app.bootstrap')
                    return Promise.resolve(bootstrap(workbenchRoot, workbenchRoot));
                if (method === 'files.browse')
                    return Promise.resolve({ entries: [], truncated: false });
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

    it('lists Project-wide name hits with their own directory when the directory has none', async () => {
        const root = await realpath(await temporaryDirectory('caxri-path-search-hit-'));
        const { browse, request } = await searchFixture(
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
            root,
        );

        const listed = await browse('resolveSafeMaxTokens');

        expect(listed.resultKind).toBe('projectSearch');
        expect(listed.entries).toEqual([
            expect.objectContaining({
                directoryLabel: 'a/b',
                kind: 'file',
                name: 'resolveSafeMaxTokens.ts',
            }),
            expect.objectContaining({
                directoryLabel: 'a/b',
                kind: 'file',
                name: 'resolveSafeMaxTokens.test.ts',
            }),
        ]);
        expect(request).toHaveBeenCalledWith(
            'files.search',
            expect.objectContaining({ mode: 'name', query: 'resolveSafeMaxTokens' }),
        );
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
            root,
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
            root,
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

        expect(listed.resultKind).toBe('projectSearch');
        expect(listed.entries).toEqual([]);
        expect(listed.truncated).toBe(true);
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
            root,
        );

        await browse('resolve');
        const refined = await browse('resolveSafe');

        expect(refined.entries.map((entry) => entry.name)).toEqual(['resolveSafeMaxTokens.ts']);
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
            root,
        );

        await browse('resolve');
        await browse('resolveSafe');

        expect(request.mock.calls.filter(([method]) => method === 'files.search')).toHaveLength(2);
    });

    it('keeps an input carrying a separator on the existing path behavior', async () => {
        const { browse, request } = await searchFixture(() => {
            throw new Error('files.search must not run for an explicit path');
        });

        const listed = await browse('./missing');

        expect(listed.resultKind).toBe('directory');
        expect(listed.entries).toEqual([]);
        expect(request).not.toHaveBeenCalledWith('files.search', expect.anything());
    });

    it('keeps the authoritative empty listing when the search engine is unavailable', async () => {
        const { browse } = await searchFixture(() => {
            throw new CaxriError('UNAVAILABLE', 'Project search engine is unavailable');
        });

        const listed = await browse('anything');

        expect(listed.resultKind).toBe('directory');
        expect(listed.entries).toEqual([]);
        expect(listed.truncated).toBe(false);
    });

    it('skips the fallback when the directory listing itself was truncated', async () => {
        const workbenchRoot = await realpath(await temporaryDirectory('caxri-path-search-trunc-'));
        const { authority, request } = authorityOptions(workbenchRoot, workbenchRoot, {
            request(method) {
                if (method === 'app.bootstrap')
                    return Promise.resolve(bootstrap(workbenchRoot, workbenchRoot));
                if (method === 'files.browse')
                    return Promise.resolve({ entries: [], truncated: true });
                return Promise.reject(new Error(`Unexpected method: ${method}`));
            },
        });
        const initial = await authority.start({ sessionId: 'session-1' });

        const listed = await authority.browse({
            browserId: initial.browserId,
            mode: 'project',
            input: 'name',
        });

        expect(listed.resultKind).toBe('directory');
        expect(request).not.toHaveBeenCalledWith('files.search', expect.anything());
    });
});
