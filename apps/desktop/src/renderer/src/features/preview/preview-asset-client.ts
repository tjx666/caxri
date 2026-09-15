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

const cache = new Map<string, CacheEntry>();
const pending = new Map<string, Promise<string | undefined>>();

function cacheKey(sessionId: string, path: string): string {
    return `${sessionId}\0${path}`;
}

function decodeBase64(base64: string): Uint8Array<ArrayBuffer> {
    const binary = atob(base64);
    // Allocating the buffer explicitly keeps the view typed over an `ArrayBuffer`, which is what `Blob` accepts.
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    // `atob` yields one code unit per byte, so a code point can never exceed 0xff here.
    for (let index = 0; index < binary.length; index += 1)
        bytes[index] = binary.codePointAt(index) ?? 0;
    return bytes;
}

async function readAsset(sessionId: string, path: string): Promise<string | undefined> {
    try {
        const asset = await caxri.request('files.readAsset', { sessionId, path });
        const blob = new Blob([decodeBase64(asset.base64)], { type: asset.mediaType });
        return URL.createObjectURL(blob);
    } catch {
        // A missing, oversized, or unauthorized image is an ordinary document defect: the caller shows a placeholder.
        return undefined;
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
             * would kill the very entry every one of them is about to render. Only a genuinely separate read — one that
             * started after the cached entry was dropped — produces a duplicate worth revoking.
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
