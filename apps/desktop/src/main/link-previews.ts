import type { MethodResult } from '@caxri/protocol';
import {
    MAX_LINK_PREVIEW_DESCRIPTION_LENGTH,
    MAX_LINK_PREVIEW_TITLE_LENGTH,
    MAX_LINK_PREVIEW_URL_LENGTH,
} from '@caxri/protocol';

type Fetch = (
    url: string,
    init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<Response>;

type LinkPreview = MethodResult<'links.preview'>;

/**
 * Pages declare their summary in `<head>`, which fits well inside this many bytes; reading stops there so a large page
 * or a file download never streams in whole.
 */
const MAX_PAGE_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 5000;
/**
 * URLs remembered, answered or not, for the life of the app: hovering the same link again must not cost a request.
 */
const MAX_CACHED_URLS = 256;

/**
 * The named entities page titles actually use; any other stays as written.
 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
    amp: '&',
    apos: "'",
    copy: '\u{A9}',
    gt: '>',
    hellip: '\u{2026}',
    laquo: '\u{AB}',
    ldquo: '\u{201C}',
    lsquo: '\u{2018}',
    lt: '<',
    mdash: '\u{2014}',
    middot: '\u{B7}',
    nbsp: ' ',
    ndash: '\u{2013}',
    quot: '"',
    raquo: '\u{BB}',
    rdquo: '\u{201D}',
    reg: '\u{AE}',
    rsquo: '\u{2019}',
    trade: '\u{2122}',
};

function decodeEntities(value: string): string {
    return value.replaceAll(/&(#x[\da-f]+|#\d+|[a-z]+);/giu, (entity, body: string) => {
        if (body.startsWith('#')) {
            const code =
                body[1] === 'x' || body[1] === 'X'
                    ? Number.parseInt(body.slice(2), 16)
                    : Number(body.slice(1));
            return code > 0 && code <= 0x10_ff_ff ? String.fromCodePoint(code) : entity;
        }
        return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
    });
}

function cleanText(value: string | undefined, limit: number): string | undefined {
    if (value === undefined) return undefined;
    const text = decodeEntities(value).replaceAll(/\s+/gu, ' ').trim();
    if (!text) return undefined;
    return text.length <= limit ? text : `${text.slice(0, limit - 1)}\u{2026}`;
}

function tagAttributes(tag: string): Map<string, string> {
    const attributes = new Map<string, string>();
    for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gu)) {
        const name = match[1].toLowerCase();
        // Exactly one quoting style matched; the other groups are `undefined` at runtime despite their `string` type.
        const value = match.slice(2).find((group: string | undefined) => group !== undefined);
        if (!attributes.has(name)) attributes.set(name, value ?? '');
    }
    return attributes;
}

function imageUrl(value: string | undefined, pageUrl: string): string | undefined {
    if (!value) return undefined;
    try {
        const url = new URL(decodeEntities(value.trim()), pageUrl);
        return url.protocol === 'https:' && url.href.length <= MAX_LINK_PREVIEW_URL_LENGTH
            ? url.href
            : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Reads a page's summary from its markup: Open Graph first, then Twitter Card, then the plain `<title>` and
 * description. A relative share image resolves against the page's final URL. Regular expressions rather than a DOM,
 * because Main has no DOM and the meta tags are flat.
 */
export function parseLinkPreview(html: string, pageUrl: string): LinkPreview {
    const headEnd = html.search(/<\/head\s*>/iu);
    const head = headEnd === -1 ? html : html.slice(0, headEnd);
    const meta = new Map<string, string>();
    for (const [tag] of head.matchAll(/<meta\b[^>]*>/giu)) {
        const attributes = tagAttributes(tag);
        const key = (attributes.get('property') ?? attributes.get('name'))?.toLowerCase();
        const content = attributes.get('content');
        if (key && content !== undefined && !meta.has(key)) meta.set(key, content);
    }
    const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/iu.exec(head)?.[1];
    const title = cleanText(
        meta.get('og:title') ?? meta.get('twitter:title') ?? titleTag,
        MAX_LINK_PREVIEW_TITLE_LENGTH,
    );
    const description = cleanText(
        meta.get('og:description') ?? meta.get('twitter:description') ?? meta.get('description'),
        MAX_LINK_PREVIEW_DESCRIPTION_LENGTH,
    );
    const image = imageUrl(
        meta.get('og:image:secure_url') ??
            meta.get('og:image') ??
            meta.get('og:image:url') ??
            meta.get('twitter:image') ??
            meta.get('twitter:image:src'),
        pageUrl,
    );
    return {
        ...(title && { title }),
        ...(description && { description }),
        ...(image && { imageUrl: image }),
    };
}

function charset(contentType: string): string {
    return /charset\s*=\s*"?([\w-]+)/iu.exec(contentType)?.[1] ?? 'utf8';
}

/**
 * The start of the body, up to `MAX_PAGE_BYTES` or the end of `<head>`, whichever comes first.
 */
async function readHead(response: Response): Promise<string> {
    let decoder: TextDecoder;
    try {
        decoder = new TextDecoder(charset(response.headers.get('content-type') ?? ''));
    } catch {
        decoder = new TextDecoder();
    }
    const reader = response.body?.getReader();
    if (!reader) return '';
    let html = '';
    let bytes = 0;
    try {
        while (bytes < MAX_PAGE_BYTES) {
            // eslint-disable-next-line no-await-in-loop -- a body stream yields its chunks one read at a time
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            html += decoder.decode(value, { stream: true });
            if (/<\/head\s*>/iu.test(html)) break;
        }
    } finally {
        // eslint-disable-next-line no-void -- cancelling the rest of the body has nothing to report
        void reader.cancel().catch(() => {});
    }
    return html;
}

async function fetchPreview(fetch: Fetch, url: string): Promise<LinkPreview | undefined> {
    try {
        const response = await fetch(url, {
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            headers: { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1' },
        });
        const type = response.headers.get('content-type')?.toLowerCase() ?? '';
        if (!response.ok || !(type.includes('text/html') || type.includes('xhtml'))) return {};
        return parseLinkPreview(await readHead(response), response.url || url);
    } catch {
        // Offline, blocked, timed out, or refused: the card shows the host alone, which is all a missing preview costs.
        return undefined;
    }
}

/**
 * Page previews for transcript links, fetched once per URL. `fetch` is Electron's `net.fetch` in the app, so the system
 * proxy, cookies, and Chromium's HTTP cache apply as they would in a browser tab. A request that failed outright is
 * forgotten rather than cached, so a link first hovered while offline previews once the network is back.
 */
export function createLinkPreviews(fetch: Fetch) {
    const cache = new Map<string, Promise<LinkPreview>>();
    async function read(
        url: string,
        attempt: Promise<LinkPreview | undefined>,
    ): Promise<LinkPreview> {
        const result = await attempt;
        if (result) return result;
        cache.delete(url);
        return {};
    }
    return (url: string): Promise<LinkPreview> => {
        let preview = cache.get(url);
        if (!preview) {
            if (cache.size >= MAX_CACHED_URLS) cache.delete(cache.keys().next().value!);
            preview = read(url, fetchPreview(fetch, url));
            cache.set(url, preview);
        }
        return preview;
    };
}
