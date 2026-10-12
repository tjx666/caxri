import type { Buffer } from 'node:buffer';
import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';

import type { AgentChatImageMediaType, MethodResult } from '@caxri/protocol';
import { MAX_AGENT_CHAT_PICKED_IMAGES_BYTES } from '@caxri/protocol';
import type { BrowserWindow } from 'electron';
import { dialog } from 'electron';

import { agentChatPathPickerOptions } from './native-file-dialogs';

/**
 * Image extensions the composer can attach, by the media type it sends them as. A file whose content does not match its
 * extension fails to decode in the Renderer, which then says it could not read it.
 */
const IMAGE_MEDIA_TYPES = new Map<string, AgentChatImageMediaType>([
    ['.gif', 'image/gif'],
    ['.jpeg', 'image/jpeg'],
    ['.jpg', 'image/jpeg'],
    ['.png', 'image/png'],
    ['.webp', 'image/webp'],
]);

/**
 * Bytes of `path` when it is an image file that fits in `budget`, or `undefined` to cite it by path. A folder named
 * like an image, a file that vanished, or one past the budget is never read.
 */
async function readPickedImage(path: string, budget: number): Promise<Buffer | undefined> {
    try {
        const stats = await stat(path);
        if (!stats.isFile() || stats.size === 0 || stats.size > budget) return undefined;
        const bytes = await readFile(path);
        return bytes.length <= budget ? bytes : undefined;
    } catch {
        return undefined;
    }
}

/**
 * `dialog.selectPaths`: the Chat composer's native open panel for files and folders together. It returns only what the
 * user chose and grants nothing, unlike `dialog.selectDirectory`, so a pick never widens a Project's access. With
 * `shouldReadImages`, image files carry their bytes until the pick's image budget runs out; the composer attaches those
 * and cites everything else, folders included, by path.
 */
export async function selectAgentChatPaths(
    window: BrowserWindow | undefined,
    { shouldReadImages }: { shouldReadImages: boolean },
): Promise<MethodResult<'dialog.selectPaths'>> {
    const options = agentChatPathPickerOptions();
    const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);
    if (result.canceled) return [];
    let budget = MAX_AGENT_CHAT_PICKED_IMAGES_BYTES;
    const picked: MethodResult<'dialog.selectPaths'> = [];
    for (const path of result.filePaths) {
        const mediaType = shouldReadImages
            ? IMAGE_MEDIA_TYPES.get(extname(path).toLowerCase())
            : undefined;
        // One at a time on purpose: each read spends the budget the next one is checked against.
        // eslint-disable-next-line no-await-in-loop -- sequential by design, see above
        const bytes = mediaType ? await readPickedImage(path, budget) : undefined;
        if (mediaType && bytes) {
            budget -= bytes.length;
            picked.push({ path, image: { mediaType, base64: bytes.toString('base64') } });
        } else picked.push({ path });
    }
    return picked;
}
