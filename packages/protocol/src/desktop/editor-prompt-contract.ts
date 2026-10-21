import { z } from 'zod';

import { commandPolicy } from '../transport/method-spec.js';

const desktopControl = commandPolicy('desktop', 'control');

const unsavedEditorNamesSchema = z.array(z.string().min(1).max(1_024)).max(3);
const unsavedEditorsReplySchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('summary'),
        count: z.number().int().nonnegative(),
        names: unsavedEditorNamesSchema,
        /**
         * `files.autoSave` is on, so Main saves the buffers under the `saveAll` timeout instead of prompting; the
         * prompt appears only for what that save could not write.
         */
        autoSave: z.boolean(),
    }),
    z.object({ kind: z.literal('saved') }),
    z.object({ kind: z.literal('saveFailed'), reason: z.enum(['writeFailed', 'inactiveRoot']) }),
]);

/**
 * Native Editor prompts owned by Main. Silently discarding an unsaved buffer is the one destructive Editor action the
 * user cannot undo, so the choice is always a modal, focus-stealing native sheet rather than a Renderer dialog.
 */
export const editorPromptDesktopMethods = {
    /**
     * "Save before closing" for one Editor tab with unsaved changes.
     */
    'editor.confirmDiscard': {
        ...desktopControl,
        params: z.object({ name: z.string().min(1).max(1_024) }),
        result: z.object({ choice: z.enum(['save', 'discard', 'cancel']) }),
    },
    /**
     * The Renderer's answer to one `editor.unsavedRequest` before quitting or closing the window (issue caxri#1631).
     * `names` holds at most three file names for the native prompt; no path or buffer content leaves the Renderer.
     */
    'editor.unsavedReply': {
        ...desktopControl,
        params: z.object({
            requestId: z.string().min(1).max(64),
            reply: unsavedEditorsReplySchema,
        }),
        result: z.null(),
    },
} as const;
