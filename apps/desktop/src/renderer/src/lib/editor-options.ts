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
        fontSize: 13,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        unfoldOnClickAfterEndOfLine: settings['editor.unfoldOnClickAfterEndOfLine'],
        ...(fontFamily && { fontFamily }),
    };
}
