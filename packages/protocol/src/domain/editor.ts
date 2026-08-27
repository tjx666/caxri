import { z } from 'zod';

const positiveLineSchema = z.number().int().positive();

/**
 * Carries an explicit Editor navigation intent across Renderer, Main, and Server boundaries. A caret target preserves
 * an exact column, while a line target selects every referenced line including both endpoints.
 */
export const editorNavigationTargetSchema = z
    .discriminatedUnion('mode', [
        z.object({
            mode: z.literal('caret'),
            line: positiveLineSchema,
            column: z.number().int().positive(),
        }),
        z.object({
            mode: z.literal('line'),
            startLine: positiveLineSchema,
            endLine: positiveLineSchema,
        }),
    ])
    .refine((target) => target.mode === 'caret' || target.endLine >= target.startLine, {
        message: 'Editor line range must not be reversed',
        path: ['endLine'],
    });

export type EditorNavigationTarget = z.infer<typeof editorNavigationTargetSchema>;
