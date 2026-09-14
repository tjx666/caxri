import { useMemo } from 'react';

import type { editor as Monaco } from 'monaco-editor';

import { resolveEditorOptions } from '../lib/editor-options';
import { useWorkbenchStore } from '../stores/workbench';

/**
 * Settings-backed base options for every Monaco surface. Subscribes to the individual setting values rather than the
 * whole settings object so the returned options stay referentially stable across unrelated settings changes and Monaco
 * does not re-apply them.
 */
export function useEditorOptions(): Monaco.IEditorOptions & Monaco.IGlobalEditorOptions {
    const settings = useWorkbenchStore((state) => state.bootstrap?.settings);
    const fontFamily = settings?.['editor.fontFamily'];
    const unfoldOnClickAfterEndOfLine = settings?.['editor.unfoldOnClickAfterEndOfLine'];
    const isLoaded = settings !== undefined;
    return useMemo(
        () =>
            resolveEditorOptions(
                isLoaded
                    ? {
                          'editor.fontFamily': fontFamily ?? null,
                          'editor.unfoldOnClickAfterEndOfLine': unfoldOnClickAfterEndOfLine ?? true,
                      }
                    : undefined,
            ),
        [isLoaded, fontFamily, unfoldOnClickAfterEndOfLine],
    );
}
