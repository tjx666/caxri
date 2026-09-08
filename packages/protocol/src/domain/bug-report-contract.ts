import { z } from 'zod';

function hasReportControlCharacter(value: string): boolean {
    for (const character of value) {
        const code = character.codePointAt(0)!;
        if (code === 127 || (code !== 9 && code !== 10 && code !== 13 && code < 32)) return true;
    }
    return false;
}

export const bugReportText = z
    .string()
    .min(1)
    .max(48 * 1024)
    .refine((value) => !hasReportControlCharacter(value), 'Report contains control characters');

/**
 * The only data-URL shape a bug-report screenshot may take. Shared so the schema that validates it, the capture handler
 * that builds it, the Main handler that slices the base64 payload back off, and the Renderer rasterizer that re-encodes
 * an annotated copy can never drift into three slightly different literals.
 */
export const BUG_REPORT_JPEG_DATA_URL_PREFIX = 'data:image/jpeg;base64,';

export const bugReportScreenshot = z.object({
    dataUrl: z
        .string()
        .startsWith(BUG_REPORT_JPEG_DATA_URL_PREFIX)
        .max(12 * 1024 * 1024),
    height: z.number().int().positive().max(16_384),
    width: z.number().int().positive().max(16_384),
});
