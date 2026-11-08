import { z } from 'zod';

import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';

/**
 * Upper bound on copied text. A copied CSV table or bug report stays far below it; the ceiling only keeps a runaway
 * payload from flooding Main.
 */
const CLIPBOARD_TEXT_LIMIT = 16 * 1024 * 1024;

/**
 * Upper bound on files read back from the clipboard: well past a Finder selection anyone pastes into a folder at once.
 */
export const CLIPBOARD_FILE_PATH_LIMIT = 1000;

/**
 * Upper bound on a copied image's data URL. A Chat image is at most 5 MiB (`MAX_AGENT_CHAT_IMAGE_BYTES`), about 7 MiB
 * once base64-encoded; the ceiling leaves room for that and keeps a runaway payload from flooding Main.
 */
const CLIPBOARD_IMAGE_DATA_URL_LIMIT = 24 * 1024 * 1024;

/**
 * Clipboard writes owned by Main. The Renderer's `navigator.clipboard.writeText` rejects with `NotAllowedError`
 * whenever its document lacks focus, which happens after a native context menu closes and before the window hands focus
 * back, and when an OSC 52 sequence arrives while another app is in front. Electron's Main clipboard has no focus
 * requirement, so every Renderer copy goes through it.
 */
export const clipboardMethods = {
    'clipboard.write': {
        ...commandPolicy('desktop', 'control'),
        params: z.object({
            text: z.string().max(CLIPBOARD_TEXT_LIMIT),
            /**
             * An HTML flavor committed in the same clipboard item as `text`.
             */
            html: z.string().max(CLIPBOARD_TEXT_LIMIT).optional(),
        }),
        result: z.null(),
    },
    /**
     * Puts an image on the clipboard as PNG, from a `data:image/...` URL the Renderer already shows, such as a Chat
     * message's image in its preview. Main decodes it first, so a payload that is not an image never reaches the
     * clipboard.
     */
    'clipboard.writeImage': {
        ...commandPolicy('desktop', 'control'),
        params: z.object({
            dataUrl: z.string().startsWith('data:image/').max(CLIPBOARD_IMAGE_DATA_URL_LIMIT),
        }),
        result: z.null(),
    },
    /**
     * The files Finder (or another app) put on the system clipboard, as absolute paths; empty when it holds none. Main
     * reads them because the Renderer's clipboard exposes no file list outside a real paste event, and the Files tree
     * handles Cmd+V as a key press.
     */
    'clipboard.readFilePaths': {
        ...commandPolicy('desktop', 'read'),
        params: z.object({}).default({}),
        result: z.object({ paths: z.array(z.string()).max(CLIPBOARD_FILE_PATH_LIMIT) }),
    },
} as const satisfies Record<string, MethodSpec>;
