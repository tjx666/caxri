/**
 * Pure helpers for choosing Monaco's base theme ('vs' vs 'vs-dark').
 *
 * Split from `editor-theme.ts` so tests can exercise the selection logic without importing the real `monaco-editor`
 * module (see `./monaco`, which pulls in editor workers and browser-only globals at module load time).
 */

import { relativeLuminance } from '@caxri/utils';

/**
 * Threshold below which a background is treated as dark for Monaco's base theme.
 */
const DARK_LUMINANCE_THRESHOLD = 0.5;

/**
 * Picks Monaco's built-in base theme ('vs' for light, 'vs-dark' for dark) from the editor canvas background color,
 * since `ThemeTokens` has no explicit light/dark kind field to read.
 *
 * @param editorBackground - The `#rrggbb` color Monaco's editor background uses.
 */
export function monacoBaseThemeFor(editorBackground: string): 'vs' | 'vs-dark' {
    return relativeLuminance(editorBackground) >= DARK_LUMINANCE_THRESHOLD ? 'vs' : 'vs-dark';
}
