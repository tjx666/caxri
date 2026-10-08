import { Semaphore } from 'es-toolkit';

import { caxri } from '../../lib/caxri';

/**
 * Resolves images a preview refers to into object URLs.
 *
 * Bytes arrive over the ordinary request channel and become a `blob:` URL, so the document's `img` elements never carry
 * a filesystem path and the Renderer's Content-Security-Policy keeps forbidding `file:`. Entries are cached per Session
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

function cacheKey(sessionId: string, path: string): string {
    return `${sessionId}\0${path}`;
}

/**
 * Decodes one asset's payload.
 *
 * `Uint8Array.fromBase64` is the fast path and is what the Renderer actually runs, but it does not exist in the Node
 * runtime this module's unit tests execute under. Without the fallback every decode there threw, the read reported an
 * ordinary missing-image failure, and the suite's refcount cases silently asserted against `undefined` instead of the
 * behavior they describe. The fallback reads one character at a time rather than through `Uint8Array.from`, which pays
 * a callback per byte across an asset that may reach the 8 MiB read ceiling.
 */
function decodeAsset(base64: string): Uint8Array<ArrayBuffer> {
    if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(base64);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1)
        bytes[index] = binary.codePointAt(index) ?? 0;
    return bytes;
}

async function readAsset(sessionId: string, path: string): Promise<string | undefined> {
    await assetReads.acquire();
    try {
        const asset = await caxri.request('files.readAsset', { sessionId, path });
        const blob = new Blob([decodeAsset(asset.base64)], { type: asset.mediaType });
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
export async function acquireAsset(sessionId: string, path: string): Promise<string | undefined> {
    const key = cacheKey(sessionId, path);
    const cached = cache.get(key);
    if (cached) {
        cached.users += 1;
        return cached.objectUrl;
    }
    const inFlight = pending.get(key) ?? readAsset(sessionId, path);
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

export function releaseAsset(sessionId: string, path: string): void {
    const key = cacheKey(sessionId, path);
    const entry = cache.get(key);
    if (!entry) return;
    entry.users -= 1;
    if (entry.users > 0) return;
    URL.revokeObjectURL(entry.objectUrl);
    cache.delete(key);
}
