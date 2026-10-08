import type { AppSettings } from '@caxri/protocol';
import { defaultAppSettings } from '@caxri/protocol';
import { cssFontFamilyEntry } from '@caxri/utils';
import type { editor as Monaco } from 'monaco-editor';

/**
 * The subset of `settings.jsonc` that maps onto Monaco editor options.
 */
export type EditorOptionSettings = Pick<
    AppSettings,
    | 'editor.autoClosingDelete'
    | 'editor.bracketPairColorization.enabled'
    | 'editor.cursorBlinking'
    | 'editor.cursorSmoothCaretAnimation'
    | 'editor.dragAndDrop'
    | 'editor.fontFamily'
    | 'editor.fontSize'
    | 'editor.guides.bracketPairs'
    | 'editor.linkedEditing'
    | 'editor.minimap.enabled'
    | 'editor.renderWhitespace'
    | 'editor.smoothScrolling'
    | 'editor.stickyScroll.enabled'
    | 'editor.stickyTabStops'
    | 'editor.unfoldOnClickAfterEndOfLine'
    | 'editor.wordSeparators'
    | 'editor.wordWrap'
>;

/**
 * Every settings key `resolveEditorOptions` reads, so a consumer can watch exactly this slice instead of the whole
 * settings object. Keep it in step with `EditorOptionSettings`; `editor-options.test.ts` fails when they drift.
 */
export const EDITOR_OPTION_KEYS = [
    'editor.autoClosingDelete',
    'editor.bracketPairColorization.enabled',
    'editor.cursorBlinking',
    'editor.cursorSmoothCaretAnimation',
    'editor.dragAndDrop',
    'editor.fontFamily',
    'editor.fontSize',
    'editor.guides.bracketPairs',
    'editor.linkedEditing',
    'editor.minimap.enabled',
    'editor.renderWhitespace',
    'editor.smoothScrolling',
    'editor.stickyScroll.enabled',
    'editor.stickyTabStops',
    'editor.unfoldOnClickAfterEndOfLine',
    'editor.wordSeparators',
    'editor.wordWrap',
] as const satisfies ReadonlyArray<keyof EditorOptionSettings>;

/**
 * Monaco spells this one `true | false | 'active'` rather than as a plain enum, so the three-way setting is mapped here
 * instead of being stored in Monaco's own shape: a settings file should not have to know that.
 */
const BRACKET_PAIR_GUIDES = { active: 'active', all: true, off: false } as const;

/**
 * Base options every Monaco surface (code editor, config editor, transcript, Git diffs) starts from. Callers spread
 * this first and override per-surface fields such as `readOnly` after it. Settings-driven fields are resolved here so a
 * new `editor.*` setting reaches every surface through one place.
 *
 * The defaults deliberately turn on behavior VS Code ships on and Monaco leaves off, because a standalone Monaco is the
 * editor core without the product decisions layered on top of it: sticky scroll, bracket pair colorization, and linked
 * editing are all things a VS Code user has every reason to expect and no way to ask for. Each one is a setting rather
 * than a hardcode, so the opinion is a starting point rather than a verdict.
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
         * behavior depend on invisible history: the same `()` deletes as a pair or as one character depending on
         * whether the editor happened to type it, and the pair that is already in the file is exactly the one a user is
         * editing. It only ever fires on an adjacent empty pair, so `(foo)` is never touched.
         */
        autoClosingDelete: settings['editor.autoClosingDelete'],
        bracketPairColorization: {
            enabled: settings['editor.bracketPairColorization.enabled'],
        },
        cursorBlinking: settings['editor.cursorBlinking'],
        cursorSmoothCaretAnimation: settings['editor.cursorSmoothCaretAnimation'],
        dragAndDrop: settings['editor.dragAndDrop'],
        fontSize: settings['editor.fontSize'],
        guides: { bracketPairs: BRACKET_PAIR_GUIDES[settings['editor.guides.bracketPairs']] },
        linkedEditing: settings['editor.linkedEditing'],
        minimap: { enabled: settings['editor.minimap.enabled'] },
        renderWhitespace: settings['editor.renderWhitespace'],
        scrollBeyondLastLine: false,
        smoothScrolling: settings['editor.smoothScrolling'],
        stickyScroll: { enabled: settings['editor.stickyScroll.enabled'] },
        stickyTabStops: settings['editor.stickyTabStops'],
        unfoldOnClickAfterEndOfLine: settings['editor.unfoldOnClickAfterEndOfLine'],
        wordSeparators: settings['editor.wordSeparators'],
        wordWrap: settings['editor.wordWrap'],
        ...(fontFamily && { fontFamily }),
    };
}
