import type { Buffer } from 'node:buffer';
import { access, realpath, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';

import type { AgentChatImageMediaType, MethodResult } from '@caxri/protocol';
import { CaxriError, MAX_AGENT_CHAT_PICKED_IMAGES_BYTES } from '@caxri/protocol';
import { readBoundedRegularFile } from '@caxri/system';
import type { BrowserWindow } from 'electron';
import { dialog, shell } from 'electron';

import { agentChatPathPickerOptions } from '../native-file-dialogs';

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
 * like an image, a FIFO, a file that vanished, or one past the budget is never read in full.
 */
async function readPickedImage(path: string, budget: number): Promise<Buffer | undefined> {
    try {
        // One non-blocking handle decides regular file, size, and content, so a file replaced or grown after the pick
        // (or a FIFO swapped in) is neither read unbounded nor waited on; any refusal falls back to a path reference.
        const bytes = await readBoundedRegularFile(path, budget);
        return bytes.length > 0 ? bytes : undefined;
    } catch {
        return undefined;
    }
}

async function isDirectory(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isDirectory();
    } catch {
        return false;
    }
}

/**
 * `dialog.selectPaths`: the Chat composer's native open panel for files and folders together. It returns only what the
 * user chose and grants nothing, unlike `dialog.selectDirectory`, so a pick never widens a Project's access. With
 * `shouldReadImages`, image files carry their bytes until the pick's image budget runs out; the composer attaches those
 * and cites everything else by path, marking folders so the composer shows them as folders.
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
            continue;
        }
        // eslint-disable-next-line no-await-in-loop -- one stat per pick, in the order the user chose
        picked.push((await isDirectory(path)) ? { path, isDirectory: true } : { path });
    }
    return picked;
}

/**
 * Folder extensions macOS runs as code when opened: an app, a plug-in, an installer. A click on such a folder chip
 * shows it in Finder instead of launching it.
 */
const EXECUTABLE_BUNDLE_EXTENSIONS = new Set([
    '.app',
    '.appex',
    '.bundle',
    '.framework',
    '.kext',
    '.mpkg',
    '.pkg',
    '.plugin',
    '.prefpane',
    '.qlgenerator',
    '.saver',
    '.xpc',
]);

/**
 * Whether the folder at its resolved `target` is a bundle macOS would launch or install rather than browse: a known
 * bundle extension, or any folder carrying a bundle's `Contents/Info.plist`.
 */
async function isBundle(target: string): Promise<boolean> {
    if (EXECUTABLE_BUNDLE_EXTENSIONS.has(extname(target).toLowerCase())) return true;
    try {
        await access(join(target, 'Contents', 'Info.plist'));
        return true;
    } catch {
        return false;
    }
}

/**
 * `agentChat.openPathReference`: a file or folder chip in a sent message. A folder opens in Finder, as in the Codex
 * app; a file is revealed in its folder rather than opened, so a click never runs a script, and neither does an app or
 * other executable bundle. The bundle check reads the resolved path, since a symlink named `tools` that points at an
 * `.app` would otherwise pass as a plain folder and launch. The path came from the user's own drop, paste, or pick, so
 * it is not held to a Project root. `shell.openPath` resolves with an error message rather than rejecting, which is
 * rethrown so the click reports it.
 */
export async function openAgentChatPathReference(path: string): Promise<void> {
    let target: string;
    let isFolder: boolean;
    try {
        target = await realpath(path);
        isFolder = (await stat(target)).isDirectory();
    } catch {
        throw new CaxriError('NOT_FOUND', `${path} no longer exists`);
    }
    if (!isFolder || (await isBundle(target))) {
        shell.showItemInFolder(path);
        return;
    }
    const failure = await shell.openPath(path);
    if (failure) throw new Error(failure);
}
