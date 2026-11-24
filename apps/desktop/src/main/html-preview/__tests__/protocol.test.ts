import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => ({ protocol: { handle: vi.fn() } }));
vi.mock('electron', () => electronMock);

const externalDocuments = vi.hoisted(() => ({
    externalDocumentPath: vi.fn<(id: string) => Promise<string>>(),
}));
vi.mock('../../external-documents/registry', () => externalDocuments);

import {
    clearHtmlPreviewGrantsForTesting,
    htmlPreviewResponse,
    htmlPreviewUrl,
    resolveHtmlPreviewUrl,
} from '../protocol';

const fixture = { directory: '' };

beforeEach(async () => {
    clearHtmlPreviewGrantsForTesting();
    const directory = await mkdtemp(join(tmpdir(), 'caxri-html-preview-'));
    fixture.directory = await realpath(directory);
    await mkdir(join(fixture.directory, 'site', 'pages'), { recursive: true });
    await mkdir(join(fixture.directory, 'site', 'assets'));
    await writeFile(
        join(fixture.directory, 'site', 'pages', 'daily report.html'),
        '<link href="../assets/app.css">',
    );
    await writeFile(join(fixture.directory, 'site', 'assets', 'app.css'), 'body { color: red }');
    await writeFile(join(fixture.directory, 'secret.txt'), 'outside');
});

afterEach(async () => {
    await rm(fixture.directory, { recursive: true, force: true });
});

function fetchFrom(url: string): Promise<Response> {
    // `Request` refuses a scheme it does not know, so the URL rides on a stand-in and the handler reads `url`.
    return htmlPreviewResponse({ url } as Request);
}

describe('htmlPreviewUrl', () => {
    it('serves the page and a stylesheet it loads from a sibling folder under the same root', async () => {
        const root = join(fixture.directory, 'site');
        const url = await htmlPreviewUrl(join(root, 'pages', 'daily report.html'), root);

        expect(url).toMatch(/^caxri-html:\/\/[\da-f]{24}\/pages\/daily%20report\.html$/);
        const page = await fetchFrom(url);
        expect(page.status).toBe(200);
        expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
        expect(page.headers.get('cache-control')).toBe('no-store');

        const stylesheet = await fetchFrom(new URL('../assets/app.css', url).href);
        expect(stylesheet.status).toBe(200);
        expect(stylesheet.headers.get('content-type')).toBe('text/css; charset=utf-8');
        expect(await stylesheet.text()).toBe('body { color: red }');
    });

    it('reuses one origin for every page under the same root', async () => {
        const root = join(fixture.directory, 'site');
        await writeFile(join(root, 'index.html'), '');
        const first = new URL(await htmlPreviewUrl(join(root, 'index.html'), root));
        const second = new URL(
            await htmlPreviewUrl(join(root, 'pages', 'daily report.html'), root),
        );

        expect(second.host).toBe(first.host);
    });

    it('refuses a file that is not an HTML page and a page outside its root', async () => {
        const root = join(fixture.directory, 'site');
        await expect(htmlPreviewUrl(join(root, 'assets', 'app.css'), root)).rejects.toMatchObject({
            code: 'VALIDATION',
        });
        await writeFile(join(fixture.directory, 'outside.html'), '');
        await expect(
            htmlPreviewUrl(join(fixture.directory, 'outside.html'), root),
        ).rejects.toMatchObject({
            code: 'PATH_DENIED',
        });
    });
});

describe('grant eviction', () => {
    it('keeps a grant that is still being asked for while older unused ones are dropped', async () => {
        const kept = join(fixture.directory, 'site');
        const keptPage = join(kept, 'pages', 'daily report.html');
        const keptHost = new URL(await htmlPreviewUrl(keptPage, kept)).host;
        const folders = Array.from({ length: 64 }, (_, index) =>
            join(fixture.directory, `folder-${index}`),
        );
        await Promise.all(
            folders.map(async (folder) => {
                await mkdir(folder);
                await writeFile(join(folder, 'index.html'), '');
            }),
        );
        // Grants are issued one at a time, in order: the order is what eviction is decided by.
        await folders.reduce(async (previous, folder) => {
            await previous;
            await htmlPreviewUrl(join(folder, 'index.html'), folder);
            // The preview of the kept page keeps asking for its URL.
            expect(new URL(await htmlPreviewUrl(keptPage, kept)).host).toBe(keptHost);
        }, Promise.resolve());

        expect((await fetchFrom(`caxri-html://${keptHost}/assets/app.css`)).status).toBe(200);
    });
});

describe('htmlPreviewResponse', () => {
    it('answers 404 for a path that climbs out of the grant, directly or through a symbolic link', async () => {
        const root = join(fixture.directory, 'site');
        const url = await htmlPreviewUrl(join(root, 'pages', 'daily report.html'), root);
        const host = new URL(url).host;
        await symlink(join(fixture.directory, 'secret.txt'), join(root, 'assets', 'leak.txt'));

        expect((await fetchFrom(`caxri-html://${host}/%2E%2E/secret.txt`)).status).toBe(404);
        expect((await fetchFrom(`caxri-html://${host}/assets/leak.txt`)).status).toBe(404);
        expect((await fetchFrom(`caxri-html://${host}/assets`)).status).toBe(404);
    });

    it('answers 404 for a host no page was granted', async () => {
        expect((await fetchFrom('caxri-html://000000000000000000000000/index.html')).status).toBe(
            404,
        );
    });
});

describe('resolveHtmlPreviewUrl', () => {
    it('grants an external page only its own folder', async () => {
        const page = join(fixture.directory, 'site', 'pages', 'daily report.html');
        externalDocuments.externalDocumentPath.mockResolvedValue(page);

        const { url } = await resolveHtmlPreviewUrl({ documentId: 'document-1' }, vi.fn());

        expect(new URL(url).pathname).toBe('/daily%20report.html');
        expect((await fetchFrom(new URL('../assets/app.css', url).href)).status).toBe(404);
    });

    it('grants a Project page its whole Project root', async () => {
        const root = join(fixture.directory, 'site');
        const page = join(root, 'pages', 'daily report.html');
        const authorizeOpen = vi.fn(() =>
            Promise.resolve({
                kind: 'file',
                path: page,
                root: { path: root },
            }),
        );

        const { url } = await resolveHtmlPreviewUrl(
            { sessionId: 'session-1', path: page },
            authorizeOpen,
        );

        expect(authorizeOpen).toHaveBeenCalledWith('session-1', page);
        expect((await fetchFrom(new URL('../assets/app.css', url).href)).status).toBe(200);
    });
});
