import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';

import {
    AGENT_CHAT_MEDIA_SCHEME,
    isAgentChatVideoPath,
    parseAgentChatMediaUrl,
} from '@caxri/protocol';
import { app, nativeImage, protocol } from 'electron';

/**
 * The poster's longest edge in pixels: sharp on the message's 2x tile, small enough to stay a quick PNG.
 */
const POSTER_SIZE = 480;
/**
 * Posters kept in memory, keyed by the resolved file and its modification time, so scrolling a transcript back and
 * forth does not ask QuickLook again.
 */
const POSTER_CACHE_LIMIT = 64;

const posters = new Map<string, Uint8Array<ArrayBuffer>>();

/**
 * Serves the videos a Chat message cites to the Renderer (`agentChatMediaUrl`): the file itself, answering range
 * requests so `<video>` can seek (`agentChatByteRange`), and a poster frame QuickLook draws. Only an existing regular
 * file whose path, and resolved path, end in a video extension is served; anything else is a 404, so the scheme cannot
 * read an arbitrary file, including through a symlink named like a video. The path is not held to a Project root: like
 * a file chip's Show in Finder (`openAgentChatPathReference`), it is the user's own drop or pick, and a screen
 * recording usually sits on the Desktop. Electron accepts a privileged (streaming, fetchable) scheme only before
 * `ready`, so Main's entry calls this at module scope; the handler itself attaches once the app is ready.
 */
export function installAgentChatMediaProtocol(): void {
    protocol.registerSchemesAsPrivileged([
        {
            scheme: AGENT_CHAT_MEDIA_SCHEME,
            privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true },
        },
    ]);
    void app.whenReady().then(() => {
        protocol.handle(AGENT_CHAT_MEDIA_SCHEME, agentChatMediaResponse);
    });
}

export async function agentChatMediaResponse(request: Request): Promise<Response> {
    const target = parseAgentChatMediaUrl(request.url);
    if (!target) return new Response(null, { status: 400 });
    let resolved: string;
    let modifiedAt: number;
    let size: number;
    try {
        resolved = await realpath(target.path);
        const stats = await stat(resolved);
        if (!stats.isFile() || !isAgentChatVideoPath(resolved))
            return new Response(null, { status: 404 });
        modifiedAt = stats.mtimeMs;
        size = stats.size;
    } catch {
        return new Response(null, { status: 404 });
    }
    if (target.kind === 'video') return videoResponse(resolved, size, request.headers.get('range'));
    const poster = await posterFor(resolved, modifiedAt);
    if (!poster) return new Response(null, { status: 404 });
    return new Response(poster, { headers: { 'content-type': 'image/png' } });
}

const VIDEO_CONTENT_TYPES: Record<string, string> = {
    m4v: 'video/mp4',
    mov: 'video/quicktime',
    mp4: 'video/mp4',
    ogv: 'video/ogg',
    webm: 'video/webm',
};

/**
 * The byte range a `Range` header asks of a `size`-byte file, inclusive at both ends; `undefined` when there is no
 * header or it is not a single `bytes=` range (the whole file is sent), and `'unsatisfiable'` when it starts past the
 * end. `<video>` seeks only when the scheme answers ranges: without them Chromium reports nothing seekable and every
 * seek snaps back to the start, and `net.fetch` of a `file:` URL ignores the header.
 */
export function agentChatByteRange(
    header: string | null,
    size: number,
): 'unsatisfiable' | { end: number; start: number } | undefined {
    const match = header ? /^bytes=(\d*)-(\d*)$/u.exec(header.trim()) : null;
    if (!match || (match[1] === '' && match[2] === '')) return undefined;
    if (match[1] === '') {
        const suffix = Number(match[2]);
        if (suffix === 0 || size === 0) return 'unsatisfiable';
        return { start: Math.max(0, size - suffix), end: size - 1 };
    }
    const start = Number(match[1]);
    if (start >= size) return 'unsatisfiable';
    const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
    return end < start ? 'unsatisfiable' : { start, end };
}

function videoResponse(path: string, size: number, rangeHeader: string | null): Response {
    const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    const headers = {
        'accept-ranges': 'bytes',
        'content-type': VIDEO_CONTENT_TYPES[extension] ?? 'application/octet-stream',
    };
    const range = agentChatByteRange(rangeHeader, size);
    if (range === 'unsatisfiable')
        return new Response(null, {
            status: 416,
            headers: { ...headers, 'content-range': `bytes */${size}` },
        });
    const { start, end } = range ?? { start: 0, end: size - 1 };
    const body =
        size === 0
            ? null
            : (Readable.toWeb(
                  createReadStream(path, { start, end }),
              ) as ReadableStream<Uint8Array>);
    return new Response(body, {
        status: range ? 206 : 200,
        headers: {
            ...headers,
            'content-length': String(size === 0 ? 0 : end - start + 1),
            ...(range && { 'content-range': `bytes ${start}-${end}/${size}` }),
        },
    });
}

async function posterFor(
    path: string,
    modifiedAt: number,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
    const key = `${path}\0${modifiedAt}`;
    const cached = posters.get(key);
    if (cached) return cached;
    let image: Electron.NativeImage;
    try {
        image = await nativeImage.createThumbnailFromPath(path, {
            width: POSTER_SIZE,
            height: POSTER_SIZE,
        });
    } catch {
        // QuickLook has no preview for this file (an unsupported codec, a file still being written).
        return undefined;
    }
    if (image.isEmpty()) return undefined;
    const png = new Uint8Array(image.toPNG());
    if (posters.size >= POSTER_CACHE_LIMIT) {
        const oldest = posters.keys().next().value;
        if (oldest !== undefined) posters.delete(oldest);
    }
    posters.set(key, png);
    return png;
}
