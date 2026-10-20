import { Buffer } from 'node:buffer';

import type { MethodResult } from '@caxri/protocol';
import { MAX_LINK_FAVICON_DATA_URL_LENGTH } from '@caxri/protocol';

import type { ManualRedirectFetch, PublicHttpsFetch, ResolveHost } from './public-https-fetch';
import { createPublicHttpsFetch } from './public-https-fetch';
import { readCappedBody } from './read-capped-body';

type LinkFavicon = MethodResult<'links.favicon'>;

/**
 * Icons larger than this are a site's full-size artwork, not a 16px glyph; they stay out of the transcript.
 */
const MAX_FAVICON_BYTES = 32 * 1024;
const FETCH_TIMEOUT_MS = 5000;
/**
 * Icons remembered for the life of the app, whether they answered with an icon or definitively without one. A
 * transcript re-renders its links on every tab switch, and a site with no icon should cost one request, not one per
 * render.
 */
const MAX_CACHED_ICONS = 256;

/**
 * The icon a site serves when nothing names another one.
 */
const DEFAULT_ICON_PATH = '/favicon.ico';

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
 * The icon at `url`, `{}` when it definitively has none, or `undefined` when the request failed outright and is worth
 * retrying later.
 */
async function fetchFavicon(
    fetch: PublicHttpsFetch,
    url: string,
): Promise<LinkFavicon | undefined> {
    try {
        const result = await fetch(url, {
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        // A loopback, private, or non-HTTPS hop was refused before it was requested; the link keeps its globe.
        if (!result) return {};
        const { response } = result;
        const type = iconType(response.headers.get('content-type'));
        const declared = Number(response.headers.get('content-length'));
        if (!type || !response.ok || declared > MAX_FAVICON_BYTES) {
            // eslint-disable-next-line no-void -- a body that cannot become an icon is never read
            void response.body?.cancel().catch(() => {});
            return {};
        }
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
 * Site icons for transcript links and MCP servers, fetched once per icon URL (an origin's `/favicon.ico` unless a path
 * names another icon). `fetch` is Electron's `net.request` in the app, so the system proxy and Chromium's HTTP cache
 * apply as they would to an `<img>`; it never follows a redirect itself, so `createPublicHttpsFetch` can refuse every
 * loopback, private, or non-HTTPS hop. A request that failed outright is forgotten rather than cached, so a link first
 * rendered while offline gets its icon once the network is back.
 */
export function createLinkFavicons(fetch: ManualRedirectFetch, resolveHost: ResolveHost) {
    const publicFetch = createPublicHttpsFetch(fetch, resolveHost);
    /**
     * Not a `SingleFlight`: a settled result stays cached (bounded, oldest evicted) and only an outright failure is
     * forgotten, whereas `SingleFlight` drops every entry the moment its load settles.
     */
    const cache = new Map<string, Promise<LinkFavicon>>();
    /**
     * Resolves a cache entry and forgets it when the request failed outright. Only that exact entry is forgotten:
     * eviction may already have replaced it with a newer attempt for the same icon.
     */
    async function settle(url: string, entry: PromiseWithResolvers<LinkFavicon>): Promise<void> {
        const result = await fetchFavicon(publicFetch, url);
        if (!result && cache.get(url) === entry.promise) cache.delete(url);
        entry.resolve(result ?? {});
    }
    return (origin: string, path = DEFAULT_ICON_PATH): Promise<LinkFavicon> => {
        const url = `${origin}${path}`;
        const cached = cache.get(url);
        if (cached) return cached;
        if (cache.size >= MAX_CACHED_ICONS) cache.delete(cache.keys().next().value!);
        const entry = Promise.withResolvers<LinkFavicon>();
        cache.set(url, entry.promise);
        // eslint-disable-next-line no-void -- the entry's promise carries the outcome; settling has nothing else to report
        void settle(url, entry);
        return entry.promise;
    };
}
