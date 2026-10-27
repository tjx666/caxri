import { z } from 'zod';

import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';

/**
 * Upper bound on copied text. A copied CSV table or bug report stays far below it; the ceiling only keeps a runaway
 * payload from flooding Main.
 */
const CLIPBOARD_TEXT_LIMIT = 16 * 1024 * 1024;

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
} as const satisfies Record<string, MethodSpec>;
