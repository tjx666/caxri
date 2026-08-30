import { z } from 'zod';

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
