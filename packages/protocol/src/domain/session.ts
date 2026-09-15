import { z } from 'zod';

/**
 * Neutral automatic Session title used until the Session gains useful Agent metadata or a manual name. Shared so
 * Desktop Main can recognize it without importing Server Core domain code.
 */
export const DEFAULT_SESSION_TITLE = 'Untitled';

function hasLineBreakOrControl(value: string): boolean {
    return [...value].some((character) => {
        const code = character.codePointAt(0)!;
        return code <= 31 || (code >= 127 && code <= 159) || code === 8_232 || code === 8_233;
    });
}

export const sessionRenameTitleSchema = z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((value) => !hasLineBreakOrControl(value), {
        message: 'Session name must be a single line without control characters',
    });

/**
 * Where a restored Session lands in its Project. `top` is the default because a Session restored from the Archived
 * Sessions dialog otherwise reappears at whatever position it held before archiving — usually somewhere down a long
 * list, so the restore the user just asked for produces no visible result. `unchanged` exists for the Undo on the
 * archive notice: that button is the exact inverse of one archive, and promoting there would let an accidental archive
 * plus Undo silently rewrite an order the user arranged by dragging.
 */
export const sessionRestorePlacementSchema = z.enum(['top', 'unchanged']).default('top');
export type SessionRestorePlacement = z.infer<typeof sessionRestorePlacementSchema>;
