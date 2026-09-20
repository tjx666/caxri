import { useMemo } from 'react';

import type { editor as Monaco } from 'monaco-editor';

import { EDITOR_OPTION_KEYS, resolveEditorOptions } from '../lib/editor-options';
import { useWorkbenchStore } from '../stores/workbench';

/**
 * Settings-backed base options for every Monaco surface.
 *
 * `bootstrap.settings` is replaced on every settings write, and Monaco re-applies any options object it is handed, so
 * returning a fresh object each time would make an unrelated setting repaint every open editor. The memo is therefore
 * keyed on the values of the `editor.*` keys this hook actually reads rather than on the settings object's identity.
 */
export function useEditorOptions(): Monaco.IEditorOptions & Monaco.IGlobalEditorOptions {
    const settings = useWorkbenchStore((state) => state.bootstrap?.settings);
    const signature = settings && JSON.stringify(EDITOR_OPTION_KEYS.map((key) => settings[key]));
    return useMemo(
        () => resolveEditorOptions(settings),
        // `signature` is the value identity of the only slice of `settings` this hook reads; see the note above.
        // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional value-keyed memo
        [signature],
    );
}
