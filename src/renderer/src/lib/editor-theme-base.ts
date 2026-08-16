/**
 * Pure helpers for choosing Monaco's base theme ('vs' vs 'vs-dark').
 *
 * Split from `editor-theme.ts` so tests can exercise the selection logic without importing the real `monaco-editor`
 * module (see `./monaco`, which pulls in editor workers and browser-only globals at module load time).
 */

/**
 * Threshold below which a background is treated as dark for Monaco's base theme.
 */
const DARK_LUMINANCE_THRESHOLD = 0.5;

/**
 * Computes the relative luminance of a `#rrggbb` (or `#rrggbbaa`) color per the sRGB/Rec. 709 formula used for WCAG
 * contrast calculations.
 *
 * @param hexColor - A hex color string starting with `#`.
 * @returns Relative luminance in the `[0, 1]` range.
 */
export function relativeLuminance(hexColor: string): number {
    const hex = hexColor.replace('#', '');
    const channel = (start: number): number =>
        Number.parseInt(hex.slice(start, start + 2), 16) / 255;
    const linearize = (value: number): number =>
        value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;

    const r = linearize(channel(0));
    const g = linearize(channel(2));
    const b = linearize(channel(4));

    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Picks Monaco's built-in base theme ('vs' for light, 'vs-dark' for dark) from the editor canvas background color,
 * since `ThemeTokens` has no explicit light/dark kind field to read.
 *
 * @param editorBackground - The `#rrggbb` color Monaco's editor background uses.
 */
export function monacoBaseThemeFor(editorBackground: string): 'vs' | 'vs-dark' {
    return relativeLuminance(editorBackground) >= DARK_LUMINANCE_THRESHOLD ? 'vs' : 'vs-dark';
}
