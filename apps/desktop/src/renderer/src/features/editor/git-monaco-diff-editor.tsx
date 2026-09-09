import { useEffectEvent, useLayoutEffect, useRef } from 'react';

import type { DiffEditorProps, MonacoDiffEditor } from '@monaco-editor/react';

import { monaco } from '../../lib/monaco';
import { disposeGitDiffModels } from './git-diff-model-lifecycle';

/**
 * Explicit ownership lets unmount cancel diff work before disposing its text models.
 */
export function GitMonacoDiffEditor(
    properties: DiffEditorProps & {
        originalModelPath: string;
        modifiedModelPath: string;
    },
) {
    const container = useRef<HTMLDivElement>(null);
    const editor = useRef<MonacoDiffEditor | null>(null);
    const mountEditor = useEffectEvent(() => {
        if (!container.current) return;
        properties.beforeMount?.(monaco);
        const instance = monaco.editor.createDiffEditor(container.current, properties.options);
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
        editor.current?.updateOptions(properties.options ?? {});
    }, [properties.options]);
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
