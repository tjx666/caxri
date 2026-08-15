import { z } from 'zod';

function containsReportControlCharacter(value: string): boolean {
    for (const character of value) {
        const code = character.codePointAt(0)!;
        if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) return true;
    }
    return false;
}

export const bugReportText = z
    .string()
    .min(1)
    .max(48 * 1024)
    .refine(
        (value) => !containsReportControlCharacter(value),
        'Report contains control characters',
    );

export const bugReportScreenshot = z.object({
    dataUrl: z
        .string()
        .startsWith('data:image/jpeg;base64,')
        .max(12 * 1024 * 1024),
    height: z.number().int().positive().max(16_384),
    width: z.number().int().positive().max(16_384),
});
