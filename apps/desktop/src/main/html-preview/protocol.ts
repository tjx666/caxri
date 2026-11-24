import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';

import type { MethodResult } from '@caxri/protocol';
import {
    CaxriError,
    HTML_PREVIEW_SCHEME,
    isHtmlPreviewPath,
    previewAssetMediaType,
} from '@caxri/protocol';
import { protocol } from 'electron';

import { externalDocumentPath } from '../external-documents/registry';

/**
 * At most this many folders are served at once. A grant is reused for every page under the same root, so the cap is
 * only reached by previewing pages from that many different Projects and folders in one lifetime. The grant least
 * recently asked for is dropped first; a preview still showing it gets a fresh grant when it is opened again.
 */
const MAXIMUM_GRANTS = 64;

/**
 * Folders whose files the scheme may serve, keyed by the lowercase hexadecimal host each page is served from. The host
 * is random rather than derived from the path so a page cannot guess another grant's origin.
 *
 * A `workspace` grant (a Project root) judges containment on the lexical path and follows symbolic links inside it, the
 * way the file explorer and editor do. A `canonical` grant (an external page's folder) has no workspace link to trust,
 * so every file must resolve, links included, to a place inside the folder.
 */
interface Grant {
    root: string;
    mode: 'workspace' | 'canonical';
}

const grants = new Map<string, Grant>();

/**
 * Content types for the web-only files a page loads. Images and PDFs are owned by `previewAssetMediaType`, which is
 * consulted first so the two tables cannot drift. Anything unlisted is served as bytes, which a browser still runs as a
 * script or applies as a stylesheet only when the type says so.
 */
const WEB_CONTENT_TYPES = new Map<string, string>([
    ['.css', 'text/css; charset=utf-8'],
    ['.csv', 'text/csv; charset=utf-8'],
    ['.htm', 'text/html; charset=utf-8'],
    ['.html', 'text/html; charset=utf-8'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.json', 'application/json; charset=utf-8'],
    ['.map', 'application/json; charset=utf-8'],
    ['.md', 'text/markdown; charset=utf-8'],
    ['.mjs', 'text/javascript; charset=utf-8'],
    ['.mp3', 'audio/mpeg'],
    ['.mp4', 'video/mp4'],
    ['.otf', 'font/otf'],
    ['.ttf', 'font/ttf'],
    ['.txt', 'text/plain; charset=utf-8'],
    ['.wasm', 'application/wasm'],
    ['.webm', 'video/webm'],
    ['.woff', 'font/woff'],
    ['.woff2', 'font/woff2'],
    ['.xml', 'application/xml; charset=utf-8'],
]);

function contentTypeOf(path: string): string {
    return (
        previewAssetMediaType(path) ??
        WEB_CONTENT_TYPES.get(extname(path).toLowerCase()) ??
        'application/octet-stream'
    );
}

function isInside(directory: string, path: string): boolean {
    return (
        path === directory || path.startsWith(directory.endsWith(sep) ? directory : directory + sep)
    );
}

function grantFor(root: string, mode: Grant['mode']): string {
    const existing = [...grants].find(
        ([, granted]) => granted.root === root && granted.mode === mode,
    )?.[0];
    if (existing) {
        // Re-inserted so the eviction below drops the grant least recently asked for, not the oldest.
        grants.delete(existing);
        grants.set(existing, { root, mode });
        return existing;
    }
    const host = randomBytes(12).toString('hex');
    grants.set(host, { root, mode });
    if (grants.size > MAXIMUM_GRANTS) {
        const oldest = grants.keys().next().value as string;
        grants.delete(oldest);
    }
    return host;
}

/**
 * The URL a preview frame loads for `page`, an authorized HTML file, with `root` as the folder its subresources may
 * come from.
 *
 * With `workspace` (a Project page, where `page` is the workspace path Server Core authorized), containment is judged
 * on the normalized lexical paths and the page is then read through any symbolic link, so `docs -> ~/shared/reports`
 * previews the way it opens in the editor. Without it (an external page) both paths are canonicalized first, so a page
 * reached through a symbolic link is served from where it lives and must be inside the folder there.
 */
export async function htmlPreviewUrl(
    page: string,
    root: string,
    options: { workspace?: boolean } = {},
): Promise<string> {
    if (!isHtmlPreviewPath(page))
        throw new CaxriError('VALIDATION', 'Only an HTML page can be previewed');
    const isWorkspace = options.workspace === true;
    let judgedRoot: string;
    let judgedPage: string;
    try {
        if (isWorkspace) {
            judgedRoot = resolve(root);
            judgedPage = resolve(page);
            if (!(await stat(judgedPage)).isFile()) throw new Error('not a regular file');
        } else {
            judgedRoot = await realpath(root);
            judgedPage = await realpath(page);
        }
    } catch {
        throw new CaxriError('NOT_FOUND', 'The page no longer exists');
    }
    if (!isInside(judgedRoot, judgedPage))
        throw new CaxriError('PATH_DENIED', 'The page is outside the folder it was opened from');
    const encodedPath = relative(judgedRoot, judgedPage)
        .split(sep)
        .map((segment) => encodeURIComponent(segment))
        .join('/');
    const host = grantFor(judgedRoot, isWorkspace ? 'workspace' : 'canonical');
    return `${HTML_PREVIEW_SCHEME}://${host}/${encodedPath}`;
}

/**
 * Main's half of `htmlPreview.url`. A Project page is authorized by Server Core against its Session's Project root, and
 * the whole Project root is served, so a page may load `../assets/app.css` the way it would from a local web server. An
 * external document grants only its own folder and the folders below it, the same scope its Markdown preview's images
 * and links have.
 */
export async function resolveHtmlPreviewUrl(
    target: { sessionId: string; path: string } | { documentId: string },
    authorizeOpen: (
        sessionId: string,
        path: string,
    ) => Promise<{ kind: string; path: string; root: { path: string } }>,
): Promise<MethodResult<'htmlPreview.url'>> {
    if ('documentId' in target) {
        const page = await externalDocumentPath(target.documentId);
        return { url: await htmlPreviewUrl(page, dirname(page)) };
    }
    const entry = await authorizeOpen(target.sessionId, target.path);
    if (entry.kind !== 'file')
        throw new CaxriError('VALIDATION', 'Only an HTML page can be previewed');
    return { url: await htmlPreviewUrl(entry.path, entry.root.path, { workspace: true }) };
}

/**
 * Serves one file under a grant: the page itself and every relative stylesheet, script, image, and font it loads. A
 * path climbing out of the granted folder is a 404, as is a directory. Under a Project grant the judgment is lexical
 * and a symbolic link inside the Project is followed wherever it points, like the editor; under an external grant a
 * link must also resolve to a place inside the folder.
 *
 * `no-store` makes a reload show what an Agent just regenerated rather than Chromium's cached copy. CORS is open so
 * module scripts and `fetch` of sibling data files work from the page's own origin and from an opaque one.
 */
export async function htmlPreviewResponse(request: Request): Promise<Response> {
    let url: URL;
    try {
        url = new URL(request.url);
    } catch {
        return new Response(null, { status: 400 });
    }
    const grant = grants.get(url.hostname);
    if (!grant) return new Response(null, { status: 404 });
    const { root, mode } = grant;
    let relativePath: string;
    try {
        relativePath = decodeURIComponent(url.pathname);
    } catch {
        return new Response(null, { status: 400 });
    }
    let path: string;
    let size: number;
    try {
        path =
            mode === 'workspace'
                ? resolve(`${root}${relativePath}`)
                : await realpath(`${root}${relativePath}`);
        if (!isInside(root, path)) return new Response(null, { status: 404 });
        // `stat` follows links, so a workspace link to an outside file is read through it.
        const stats = await stat(path);
        if (!stats.isFile()) return new Response(null, { status: 404 });
        size = stats.size;
    } catch {
        return new Response(null, { status: 404 });
    }
    const body =
        size === 0 ? null : (Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>);
    return new Response(body, {
        headers: {
            'access-control-allow-origin': '*',
            'cache-control': 'no-store',
            'content-length': String(size),
            'content-type': contentTypeOf(path),
            'x-content-type-options': 'nosniff',
        },
    });
}

/**
 * The HTML preview scheme's privileges. `standard` gives each grant a real origin, so relative URLs resolve and
 * `localStorage` works; `secure` lets a page use the APIs browsers reserve for secure contexts; `corsEnabled` lets a
 * page load module scripts and `fetch` its own data files.
 */
export const HTML_PREVIEW_PRIVILEGED_SCHEME: Electron.CustomScheme = {
    scheme: HTML_PREVIEW_SCHEME,
    privileges: {
        standard: true,
        secure: true,
        stream: true,
        supportFetchAPI: true,
        corsEnabled: true,
    },
};

export function attachHtmlPreviewProtocol(): void {
    protocol.handle(HTML_PREVIEW_SCHEME, htmlPreviewResponse);
}

export function clearHtmlPreviewGrantsForTesting(): void {
    grants.clear();
}
