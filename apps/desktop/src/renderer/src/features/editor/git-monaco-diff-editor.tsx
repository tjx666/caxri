import { useEffectEvent, useLayoutEffect, useMemo, useRef } from 'react';

import type { DiffEditorProps, MonacoDiffEditor } from '@monaco-editor/react';

import { monaco } from '../../lib/monaco';
import { disposeGitDiffModels } from './git-diff-model-lifecycle';
import { useGitDiffViewStore } from './git-diff-view-store';

/**
 * Explicit ownership lets unmount cancel diff work before disposing its text models.
 */
export function GitMonacoDiffEditor(
    properties: DiffEditorProps & {
        originalModelPath: string;
        modifiedModelPath: string;
        stacked: boolean;
    },
) {
    const inlineView = useGitDiffViewStore((state) => state.inlineView);
    const collapseUnchanged = useGitDiffViewStore(
        (state) => state.collapseUnchanged ?? properties.stacked,
    );
    const showWhitespaceDifferences = useGitDiffViewStore(
        (state) => state.showWhitespaceDifferences,
    );
    const options = useMemo(
        () => ({
            ...properties.options,
            renderSideBySide: !inlineView,
            useInlineViewWhenSpaceIsLimited: false,
            hideUnchangedRegions: { enabled: collapseUnchanged },
            ignoreTrimWhitespace: !showWhitespaceDifferences,
        }),
        [properties.options, inlineView, collapseUnchanged, showWhitespaceDifferences],
    );
    const container = useRef<HTMLDivElement>(null);
    const editor = useRef<MonacoDiffEditor | null>(null);
    const mountEditor = useEffectEvent(() => {
        if (!container.current) return;
        properties.beforeMount?.(monaco);
        const instance = monaco.editor.createDiffEditor(container.current, options);
        const models = {
            original: monaco.editor.createModel(
                properties.original ?? '',
                properties.originalLanguage,
                monaco.Uri.parse(properties.originalModelPath),
            ),
            modified: monaco.editor.createModel(
                properties.modified ?? '',
                properties.modifiedLanguage,
                monaco.Uri.parse(properties.modifiedModelPath),
            ),
        };
        const viewModel = instance.createViewModel(models);
        instance.setModel(viewModel);
        editor.current = instance;
        /**
         * Monaco opens a diff at line 1. In a thousand-line file whose change is near the bottom, that is a full screen
         * of identical imports and no visible diff at all — the file reads as unchanged until the user scrolls or
         * presses F7. `revealFirstDiff` waits for the diff computation and then centers the first change, which is what
         * every other diff viewer does on open. It runs on mount only: the in-place `setValue` path below is the same
         * file refreshing, and re-revealing there would yank the scroll position out from under the reader.
         */
        instance.revealFirstDiff();
        properties.onMount?.(instance, monaco);
        return () => {
            editor.current = null;
            disposeGitDiffModels(instance, viewModel, models);
        };
    });
    useLayoutEffect(
        () => mountEditor(),
        [properties.originalModelPath, properties.modifiedModelPath],
    );
    useLayoutEffect(() => {
        editor.current?.updateOptions(options);
    }, [options]);
    useLayoutEffect(() => {
        const models = editor.current?.getModel();
        if (!models) return;
        if (models.original.getValue() !== properties.original)
            models.original.setValue(properties.original ?? '');
        if (models.modified.getValue() !== properties.modified)
            models.modified.setValue(properties.modified ?? '');
        if (properties.originalLanguage)
            monaco.editor.setModelLanguage(models.original, properties.originalLanguage);
        if (properties.modifiedLanguage)
            monaco.editor.setModelLanguage(models.modified, properties.modifiedLanguage);
    }, [
        properties.original,
        properties.modified,
        properties.originalLanguage,
        properties.modifiedLanguage,
    ]);
    return <div ref={container} className="h-full w-full" />;
}
