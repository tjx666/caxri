import type { AppSettings } from '@caxri/protocol';
import { defaultAppSettings } from '@caxri/protocol';
import { cssFontFamilyEntry } from '@caxri/utils';
import type { editor as Monaco } from 'monaco-editor';

/**
 * The subset of `settings.jsonc` that maps onto Monaco editor options.
 */
export type EditorOptionSettings = Pick<
    AppSettings,
    'editor.fontFamily' | 'editor.unfoldOnClickAfterEndOfLine'
>;

/**
 * Base options every Monaco surface (code editor, config editor, transcript, Git diffs) starts from. Callers spread
 * this first and override per-surface fields such as `readOnly`, `wordWrap`, or `fontSize` after it. Settings-driven
 * fields are resolved here so a new `editor.*` setting reaches every surface through one place.
 */
export function resolveEditorOptions(
    settings: EditorOptionSettings | undefined = defaultAppSettings,
): Monaco.IEditorOptions & Monaco.IGlobalEditorOptions {
    // `undefined` keeps Monaco's built-in monospace default instead of overriding it with an empty string.
    const fontFamily = cssFontFamilyEntry(settings['editor.fontFamily']);
    return {
        automaticLayout: true,
        /**
         * Deleting one half of an empty bracket or quote pair takes the other half with it, whoever wrote it.
         *
         * Monaco and VS Code both default to `auto`, which only does this for a pair the editor auto-inserted during
         * this session (`cursorDeleteOperations.ts`: the pair must appear in `autoClosedCharacters`). That makes the
         * behavior depend on invisible history — the same `()` deletes as a pair or as one character depending on
         * whether the editor happened to type it — and the pair that is already in the file is exactly the one a user
         * is editing. `always` still only fires on an adjacent empty pair, so `(foo)` is never touched.
         */
        autoClosingDelete: 'always',
        fontSize: 13,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        unfoldOnClickAfterEndOfLine: settings['editor.unfoldOnClickAfterEndOfLine'],
        ...(fontFamily && { fontFamily }),
    };
}
