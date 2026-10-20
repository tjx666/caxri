import { Semaphore } from 'es-toolkit';

import { caxri } from '../../lib/caxri';

/**
 * Resolves images a preview refers to into object URLs.
 *
 * Bytes arrive over the ordinary request channel and become a `blob:` URL, so the document's `img` elements never carry
 * a filesystem path and the Renderer's Content-Security-Policy keeps forbidding `file:`. Entries are cached per source
 * and path because one document usually shows the same asset in several places, and a re-render must not re-read it.
 */
interface CacheEntry {
    objectUrl: string;
    users: number;
}

/**
 * Four reads let small assets overlap without admitting a whole illustrated document's 8 MiB images at once. The permit
 * spans IPC, native decoding, and Blob creation, and is shared by every mounted preview in this Renderer.
 */
const assetReads = new Semaphore(4);

const cache = new Map<string, CacheEntry>();
const pending = new Map<string, Promise<string | undefined>>();

/**
 * Who authorizes an image read: a Session's Project for a Project document, or Main's grant for an external document,
 * which covers the document's folder (`directory`) and the folders below it.
 */
export type PreviewAssetSource =
    { sessionId: string } | { externalDocumentId: string; directory: string };

function cacheKey(source: PreviewAssetSource, path: string): string {
    return 'sessionId' in source
        ? `${source.sessionId}\0${path}`
        : `external:${source.externalDocumentId}\0${path}`;
}

/**
 * Splits a source and absolute path into the method and params that read it. Main resolves an external path against the
 * document's folder itself; only the part below that folder crosses IPC.
 */
function assetRequest(source: PreviewAssetSource, path: string) {
    if ('sessionId' in source)
        return {
            method: 'files.readAsset',
            params: { sessionId: source.sessionId, path },
        } as const;
    const prefix = source.directory.endsWith('/') ? source.directory : `${source.directory}/`;
    if (!path.startsWith(prefix)) throw new Error('Image is outside the document folder');
    return {
        method: 'externalDocument.readAsset',
        params: { documentId: source.externalDocumentId, path: path.slice(prefix.length) },
    } as const;
}

async function requestAsset(source: PreviewAssetSource, path: string) {
    const request = assetRequest(source, path);
    return request.method === 'files.readAsset'
        ? caxri.request(request.method, request.params)
        : caxri.request(request.method, request.params);
}

/**
 * Decodes one base64 payload: an asset read, or bundled binary data carried as a `data:` URL.
 *
 * `Uint8Array.fromBase64` is the fast path and is what the Renderer actually runs, but it does not exist in the Node
 * runtime this module's unit tests execute under. Without the fallback every decode there threw, the read reported an
 * ordinary missing-image failure, and the suite's refcount cases silently asserted against `undefined` instead of the
 * behavior they describe. The fallback reads one character at a time rather than through `Uint8Array.from`, which pays
 * a callback per byte across an asset that may reach the 8 MiB read ceiling.
 */
export function decodeBase64(base64: string): Uint8Array<ArrayBuffer> {
    if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(base64);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1)
        bytes[index] = binary.codePointAt(index) ?? 0;
    return bytes;
}

async function readAsset(source: PreviewAssetSource, path: string): Promise<string | undefined> {
    await assetReads.acquire();
    try {
        const asset = await requestAsset(source, path);
        const blob = new Blob([decodeBase64(asset.base64)], { type: asset.mediaType });
        return URL.createObjectURL(blob);
    } catch {
        // A missing, oversized, or unauthorized image is an ordinary document defect: the caller shows a placeholder.
        return undefined;
    } finally {
        assetReads.release();
    }
}

/**
 * Hands back an object URL for one asset, sharing it with every other caller that asked for the same file.
 *
 * Every successful call must be paired with `releaseAsset` so the last user revokes the URL.
 */
export async function acquireAsset(
    source: PreviewAssetSource,
    path: string,
): Promise<string | undefined> {
    const key = cacheKey(source, path);
    const cached = cache.get(key);
    if (cached) {
        cached.users += 1;
        return cached.objectUrl;
    }
    const inFlight = pending.get(key) ?? readAsset(source, path);
    pending.set(key, inFlight);
    try {
        const objectUrl = await inFlight;
        if (!objectUrl) return undefined;
        const existing = cache.get(key);
        if (existing) {
            /**
             * Callers that shared one in-flight read all resolve to the _same_ URL, so revoking unconditionally here
             * would kill the very entry every one of them is about to render. Only a genuinely separate read (one that
             * started after the cached entry was dropped) produces a duplicate worth revoking.
             */
            if (existing.objectUrl !== objectUrl) URL.revokeObjectURL(objectUrl);
            existing.users += 1;
            return existing.objectUrl;
        }
        cache.set(key, { objectUrl, users: 1 });
        return objectUrl;
    } finally {
        pending.delete(key);
    }
}

export function releaseAsset(source: PreviewAssetSource, path: string): void {
    const key = cacheKey(source, path);
    const entry = cache.get(key);
    if (!entry) return;
    entry.users -= 1;
    if (entry.users > 0) return;
    URL.revokeObjectURL(entry.objectUrl);
    cache.delete(key);
}

/**
 * Reads a whole binary file a preview renders itself (a PDF) as bytes, without an object URL or a shared cache entry:
 * the view owns the decoded document for as long as it is mounted, and a second copy in a cache would double the
 * largest payload a preview reads. An external document's PDF is read under the same grant as its linked images.
 */
export async function readAssetBytes(
    source: PreviewAssetSource,
    path: string,
    signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
    const request = assetRequest(source, path);
    const asset =
        request.method === 'files.readAsset'
            ? await caxri.requestWithSignal(request.method, signal, request.params)
            : await caxri.requestWithSignal(request.method, signal, request.params);
    return decodeBase64(asset.base64);
}

/**
 * Reads one image a preview tab shows as its whole content into an object URL the caller owns and must revoke.
 *
 * Unlike {@link acquireAsset}, a failure is thrown rather than turned into a placeholder: the tab has nothing else to
 * show, so it needs the reason (a missing file, the size ceiling) to say what went wrong and which recovery helps. It
 * also skips the shared cache, because a rewrite on disk has to produce a fresh read rather than the cached bytes.
 */
export async function readAssetObjectUrl(
    sessionId: string,
    path: string,
    signal: AbortSignal,
): Promise<string> {
    const asset = await caxri.requestWithSignal('files.readAsset', signal, { sessionId, path });
    return URL.createObjectURL(new Blob([decodeBase64(asset.base64)], { type: asset.mediaType }));
}
