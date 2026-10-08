/**
 * `settings-spec.ts` (`packages/protocol`) has no per-field font hint, so this stays a renderer-local exception rather
 * than a spec change owned by another package this batch. These string settings hold literal characters (box-drawing
 * glyphs, curly quotes, and font-family names) that the sans UI font renders as tofu (verified live for
 * `terminal.wordSeparators`'s default value); rendering their input with the monospace stack makes the glyphs resolve.
 */
const MONOSPACE_STRING_SETTING_KEYS: ReadonlySet<string> = new Set([
    'terminal.wordSeparators',
    'terminal.fontFamily',
    'editor.fontFamily',
    'editor.wordSeparators',
]);

export function isMonospaceStringSetting(key: string): boolean {
    return MONOSPACE_STRING_SETTING_KEYS.has(key);
}
