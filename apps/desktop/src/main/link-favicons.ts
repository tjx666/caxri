import { Buffer } from 'node:buffer';

import type { MethodResult } from '@caxri/protocol';
import { MAX_LINK_FAVICON_DATA_URL_LENGTH } from '@caxri/protocol';

import { readCappedBody } from './read-capped-body';

type Fetch = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

type LinkFavicon = MethodResult<'links.favicon'>;

/**
 * Icons larger than this are a site's full-size artwork, not a 16px glyph; they stay out of the transcript.
 */
const MAX_FAVICON_BYTES = 32 * 1024;
const FETCH_TIMEOUT_MS = 5000;
/**
 * Origins remembered for the life of the app, whether they answered with an icon or definitively without one. A
 * transcript re-renders its links on every tab switch, and a site with no icon should cost one request, not one per
 * render.
 */
const MAX_CACHED_ORIGINS = 256;

/**
 * Whether a response body is an icon. Many servers send `.ico` as `application/octet-stream` or with no type at all, so
 * those are accepted and labeled as an icon; an HTML error page served with 200 is not.
 */
function iconType(contentType: string | null): string | undefined {
    const type = contentType?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
    if (type.startsWith('image/')) return type;
    return type === '' || type === 'application/octet-stream' ? 'image/x-icon' : undefined;
}

/**
 * The origin's icon, `{}` when it definitively has none, or `undefined` when the request failed outright and is worth
 * retrying later.
 */
async function fetchFavicon(fetch: Fetch, origin: string): Promise<LinkFavicon | undefined> {
    try {
        const response = await fetch(`${origin}/favicon.ico`, {
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        const type = iconType(response.headers.get('content-type'));
        if (!type || !response.ok) return {};
        const declared = Number(response.headers.get('content-length'));
        if (declared > MAX_FAVICON_BYTES) return {};
        const chunks: Uint8Array[] = [];
        const end = await readCappedBody(response, MAX_FAVICON_BYTES, (chunk) => {
            chunks.push(chunk);
        });
        if (end !== 'end') return {};
        const bytes = Buffer.concat(chunks);
        if (bytes.length === 0) return {};
        const dataUrl = `data:${type};base64,${bytes.toString('base64')}`;
        return dataUrl.length <= MAX_LINK_FAVICON_DATA_URL_LENGTH ? { dataUrl } : {};
    } catch {
        // Offline, blocked, timed out, or refused: the link shows a globe for now and the next render asks again.
        return undefined;
    }
}

/**
 * Site icons for transcript links, fetched once per origin. `fetch` is Electron's `net.fetch` in the app, so the system
 * proxy and Chromium's HTTP cache apply exactly as they would to an `<img>`. A request that failed outright is
 * forgotten rather than cached, so a link first rendered while offline gets its icon once the network is back.
 */
export function createLinkFavicons(fetch: Fetch) {
    const cache = new Map<string, Promise<LinkFavicon>>();
    /**
     * Resolves a cache entry and forgets it when the request failed outright. Only that exact entry is forgotten:
     * eviction may already have replaced it with a newer attempt for the same origin.
     */
    async function settle(origin: string, entry: PromiseWithResolvers<LinkFavicon>): Promise<void> {
        const result = await fetchFavicon(fetch, origin);
        if (!result && cache.get(origin) === entry.promise) cache.delete(origin);
        entry.resolve(result ?? {});
    }
    return (origin: string): Promise<LinkFavicon> => {
        const cached = cache.get(origin);
        if (cached) return cached;
        if (cache.size >= MAX_CACHED_ORIGINS) cache.delete(cache.keys().next().value!);
        const entry = Promise.withResolvers<LinkFavicon>();
        cache.set(origin, entry.promise);
        // eslint-disable-next-line no-void -- the entry's promise carries the outcome; settling has nothing else to report
        void settle(origin, entry);
        return entry.promise;
    };
}
