import { cssFontFamilyEntry } from '@caxri/utils';

import { useSettings } from '../stores/selectors';

/**
 * Resolves the `editor.fontFamily` setting into a Monaco `fontFamily` option value; `undefined` keeps Monaco's built-in
 * monospace default.
 */
export function useEditorFontFamily(): string | undefined {
    return cssFontFamilyEntry(useSettings()?.['editor.fontFamily']);
}
