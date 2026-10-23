import { z } from 'zod';

import { MAX_CONFIGURABLE_FILE_BYTES } from '../configuration/settings-spec.js';
import { commandPolicy } from '../transport/method-spec.js';
import { externalEditorDocumentSchema } from './path-browser-contract.js';

const desktopControl = commandPolicy('desktop', 'control');
const desktopWrite = commandPolicy('desktop', 'write');

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
    /**
     * The answer to `discardAll`: the backups of the discarded buffers are gone from this device.
     */
    z.object({ kind: z.literal('discarded') }),
    /**
     * `canceled`: the user dismissed the Save As dialog of an untitled buffer, which keeps the app open like Cancel.
     */
    z.object({
        kind: z.literal('saveFailed'),
        reason: z.enum(['writeFailed', 'inactiveRoot', 'canceled']),
    }),
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
     * Save As for an untitled buffer. Main shows the native save dialog at `defaultPath`, writes `content` to the file
     * the user chose, and answers with that file registered as an external document (ADR 0013), whose `displayPath` the
     * Renderer uses to reopen it as a Project file when it landed inside the Session's Project. The dialog is the
     * authorization: the Renderer never names a path that is written without the user confirming it.
     */
    'editor.saveUntitled': {
        ...desktopWrite,
        params: z.object({
            defaultPath: z.string().min(1).max(4_096),
            content: z.string().max(MAX_CONFIGURABLE_FILE_BYTES),
        }),
        result: z.union([
            z.object({ canceled: z.literal(true) }),
            z.object({ document: externalEditorDocumentSchema }),
        ]),
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
