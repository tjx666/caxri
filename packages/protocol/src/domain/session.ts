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
