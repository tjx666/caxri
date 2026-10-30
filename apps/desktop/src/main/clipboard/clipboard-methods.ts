import { fileURLToPath } from 'node:url';

import type { MainRequest, MethodResult } from '@caxri/protocol';
import { CLIPBOARD_FILE_PATH_LIMIT } from '@caxri/protocol';
import { clipboard, ClipboardItem } from 'electron';

type ClipboardRequest = Extract<
    MainRequest,
    { method: 'clipboard.readFilePaths' | 'clipboard.write' }
>;

/**
 * The flavor macOS gives every file URL on the pasteboard, one per line. Finder writes one `public.file-url` item per
 * copied file, and Electron folds them all into this single list; the raw per-item flavors only carry the first.
 */
const FILE_URI_LIST_TYPE = 'text/uri-list';

export function isClipboardRequest(request: MainRequest): request is ClipboardRequest {
    return request.method === 'clipboard.write' || request.method === 'clipboard.readFilePaths';
}

export async function handleClipboardRequest(
    request: ClipboardRequest,
): Promise<MethodResult<ClipboardRequest['method']>> {
    if (request.method === 'clipboard.readFilePaths')
        return { paths: await readClipboardFilePaths() };
    const { html, text } = request.params;
    await (html === undefined
        ? clipboard.writeText(text)
        : clipboard.write([new ClipboardItem({ 'text/plain': text, 'text/html': html })]));
    return null;
}

/**
 * Only `file:` URLs count: a copied web link shares the flavor but names nothing on this Mac.
 */
async function readClipboardFilePaths(): Promise<string[]> {
    const items = await clipboard.read();
    const item = items.find((candidate) => candidate.types.includes(FILE_URI_LIST_TYPE));
    if (!item) return [];
    const list = await (await item.getType(FILE_URI_LIST_TYPE)).text();
    return fileUriListPaths(list).slice(0, CLIPBOARD_FILE_PATH_LIMIT);
}

/**
 * Parses an RFC 2483 `text/uri-list`: CRLF-separated, `#` lines are comments.
 */
export function fileUriListPaths(list: string): string[] {
    return list
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith('file:'))
        .map((line) => fileURLToPath(line));
}
