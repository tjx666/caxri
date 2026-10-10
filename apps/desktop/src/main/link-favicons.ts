import { Buffer } from 'node:buffer';

import type { MethodResult } from '@caxri/protocol';
import { MAX_LINK_FAVICON_DATA_URL_LENGTH } from '@caxri/protocol';

type Fetch = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

/**
 * Icons larger than this are a site's full-size artwork, not a 16px glyph; they stay out of the transcript.
 */
const MAX_FAVICON_BYTES = 32 * 1024;
const FETCH_TIMEOUT_MS = 5000;
/**
 * Origins remembered, answered or not, for the life of the app. A transcript re-renders its links on every tab switch,
 * and a site with no icon should cost one request, not one per render.
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

async function fetchFavicon(fetch: Fetch, origin: string): Promise<string | undefined> {
    try {
        const response = await fetch(`${origin}/favicon.ico`, {
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        const type = iconType(response.headers.get('content-type'));
        if (!type || !response.ok) return undefined;
        const declared = Number(response.headers.get('content-length'));
        if (declared > MAX_FAVICON_BYTES) return undefined;
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length === 0 || bytes.length > MAX_FAVICON_BYTES) return undefined;
        const dataUrl = `data:${type};base64,${bytes.toString('base64')}`;
        return dataUrl.length <= MAX_LINK_FAVICON_DATA_URL_LENGTH ? dataUrl : undefined;
    } catch {
        // Offline, blocked, timed out, or refused: the link shows a globe instead, which is all a missing icon costs.
        return undefined;
    }
}

/**
 * Site icons for transcript links, fetched once per origin. `fetch` is Electron's `net.fetch` in the app, so the system
 * proxy and Chromium's HTTP cache apply exactly as they would to an `<img>`.
 */
export function createLinkFavicons(fetch: Fetch) {
    const cache = new Map<string, Promise<string | undefined>>();
    return async (origin: string): Promise<MethodResult<'links.favicon'>> => {
        let icon = cache.get(origin);
        if (!icon) {
            if (cache.size >= MAX_CACHED_ORIGINS) cache.delete(cache.keys().next().value!);
            icon = fetchFavicon(fetch, origin);
            cache.set(origin, icon);
        }
        const dataUrl = await icon;
        return dataUrl ? { dataUrl } : {};
    };
}
