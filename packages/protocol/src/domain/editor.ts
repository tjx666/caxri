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

function positiveLine(value: string | undefined): number | undefined {
    if (!value) return;
    const line = Number(value);
    return Number.isSafeInteger(line) && line > 0 ? line : undefined;
}

/**
 * Separates an exact location suffix (`:12`, `:12:4`, `#L10-L20`) from a cited path, as a Terminal or an Agent writes
 * it, and normalizes the navigation intent. Location-shaped but invalid suffixes stay distinguishable from ordinary `#`
 * filenames so callers can reject them instead of opening a misleading literal path.
 */
export function parseFileLocation(text: string): {
    invalidLocation?: true;
    location?: EditorNavigationTarget;
    target: string;
} {
    const colon = /^(.*?):(\d+)(?::(\d+))?$/.exec(text);
    if (colon?.[1]) {
        const line = positiveLine(colon[2]);
        if (!line) return { target: colon[1], invalidLocation: true };
        const columnSource = colon.at(3);
        const column = columnSource ? positiveLine(columnSource) : undefined;
        if (!column && columnSource) return { target: colon[1], invalidLocation: true };
        return {
            target: colon[1],
            location: column
                ? { mode: 'caret', line, column }
                : { mode: 'line', startLine: line, endLine: line },
        };
    }
    const github = /^(.*?)#L(\d+)(?:-L?(\d+))?$/.exec(text);
    if (!github?.[1]) {
        const incomplete = /^(.*?)#L\d+(?:-L?\d*)?$/.exec(text);
        return incomplete?.[1]
            ? { target: incomplete[1], invalidLocation: true }
            : { target: text };
    }
    const startLine = positiveLine(github[2]);
    const endLine = positiveLine(github.at(3) ?? github[2]);
    if (!startLine || !endLine || endLine < startLine)
        return { target: github[1], invalidLocation: true };
    return {
        target: github[1],
        location: { mode: 'line', startLine, endLine },
    };
}
