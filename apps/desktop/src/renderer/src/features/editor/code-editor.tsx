import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

import type { ThemeTokens } from '@caxri/protocol';
import type { OnMount } from '@monaco-editor/react';
import Editor from '@monaco-editor/react';

import { useEditorOptions } from '@/hooks/use-editor-options';

import { applyEditorTheme } from '../../lib/editor-theme';
import { monaco } from '../../lib/monaco';
import { resolveEditorLanguage } from './editor-language';
import { synchronizeControlledEditorModel } from './editor-model-sync';
import { markEditorBeforeMount, markEditorMounted } from './editor-performance';
import { registerEditorRevealTarget } from './editor-reveal';
import { useEditorStatusStore } from './editor-status';
import { rememberEditorViewState, restoreEditorViewState } from './editor-view-state';

export interface CodeEditorProperties {
    /**
     * Distinguishes independent Monaco instances that share one document model across split panes.
     */
    editorInstanceId?: string;
    path: string;
    statusKey?: string;
    value: string;
    theme: ThemeTokens;
    readOnly?: boolean;
    onChange: (content: string | undefined) => void;
}

type MonacoCodeEditor = Parameters<OnMount>[0];

function publishEditorStatus(editor: MonacoCodeEditor, statusKey: string | undefined): void {
    if (!statusKey) return;
    const model = editor.getModel();
    const selection = editor.getSelection();
    if (!model || !selection) return;
    const start = selection.getStartPosition();
    const end = selection.getEndPosition();
    const startOffset = model.getOffsetAt(start);
    const endOffset = model.getOffsetAt(end);
    useEditorStatusStore.getState().setStatus(statusKey, {
        line: selection.positionLineNumber,
        column: selection.positionColumn,
        selectionStartLine: start.lineNumber,
        selectionEndLine:
            end.lineNumber > start.lineNumber && end.column === 1
                ? end.lineNumber - 1
                : end.lineNumber,
        selectedCharacters: Math.max(0, endOffset - startOffset),
        languageId: model.getLanguageId(),
    });
}

export function CodeEditor({
    editorInstanceId,
    path,
    statusKey,
    value,
    theme,
    readOnly,
    onChange,
}: CodeEditorProperties) {
    const editorReference = useRef<Parameters<OnMount>[0] | null>(null);
    const registrationReference = useRef<(() => void) | undefined>(undefined);
    const cursorSubscriptionReference = useRef<{ dispose(): void } | undefined>(undefined);
    const programmaticChangeReference = useRef(false);
    const statusKeyReference = useRef(statusKey);
    const language = resolveEditorLanguage(path);
    const editorOptions = useEditorOptions();
    const handleChange = useCallback(
        (content: string | undefined) => {
            if (!programmaticChangeReference.current) onChange(content);
        },
        [onChange],
    );
    useEffect(() => applyEditorTheme(theme), [theme]);
    /**
     * Scroll position and cursor outlive the widget that showed them. The two halves run in different effect phases on
     * purpose:
     *
     * - The layout cleanup records the outgoing model while Monaco is still alive — React runs it before
     *   `@monaco-editor/react`'s passive cleanup disposes the editor on unmount (a Session switch remounts the whole
     *   pane tree), and before its passive `path` effect swaps in another model;
     * - The passive body restores afterwards, once that swap has happened. It runs before the reveal registration below
     *   so an explicit navigation (a search hit, a breadcrumb jump) still wins over the remembered position, and it
     *   cannot cover the first mount, where the wrapper creates the editor asynchronously and reports it through
     *   `onMount` instead.
     */
    useLayoutEffect(
        () => () => {
            const editor = editorReference.current;
            if (editor) rememberEditorViewState(editor, editorInstanceId);
        },
        [editorInstanceId, path],
    );
    useEffect(() => {
        const editor = editorReference.current;
        if (editor) restoreEditorViewState(editor, editorInstanceId);
    }, [editorInstanceId, path]);
    useEffect(() => {
        const editor = editorReference.current;
        if (editor)
            synchronizeControlledEditorModel(
                editor,
                monaco.Uri.parse(path).toString(),
                value,
                programmaticChangeReference,
            );
    }, [path, value]);
    useEffect(() => {
        const editor = editorReference.current;
        if (!editor) return;
        /**
         * Monaco 0.56 can leave a newly selected custom-language model un-tokenized while its background scheduler is
         * busy. Prime the registered Monarch grammar, then rebind the model once per path so Monaco schedules
         * tokenization for the visible model immediately.
         */
        const model = editor.getModel();
        if (language && model?.getLanguageId() === language) {
            monaco.editor.tokenize(model.getLineContent(1), language);
            monaco.editor.setModelLanguage(model, 'plaintext');
            monaco.editor.setModelLanguage(model, language);
        }
        registrationReference.current?.();
        const unregister = registerEditorRevealTarget(path, editor, editorInstanceId);
        registrationReference.current = unregister;
        return () => {
            unregister();
            if (registrationReference.current === unregister)
                registrationReference.current = undefined;
        };
    }, [editorInstanceId, language, path]);
    useEffect(() => {
        statusKeyReference.current = statusKey;
        const frame = requestAnimationFrame(() => {
            if (editorReference.current) publishEditorStatus(editorReference.current, statusKey);
        });
        return () => {
            cancelAnimationFrame(frame);
            if (statusKey) useEditorStatusStore.getState().clearStatus(statusKey);
        };
    }, [path, statusKey]);
    useEffect(
        () => () => {
            cursorSubscriptionReference.current?.dispose();
        },
        [],
    );
    return (
        <Editor
            path={path}
            language={language}
            saveViewState={false}
            value={value}
            theme="caxri-active"
            beforeMount={() => {
                markEditorBeforeMount();
                applyEditorTheme(theme);
            }}
            onMount={(editor: Parameters<OnMount>[0]) => {
                editorReference.current = editor;
                cursorSubscriptionReference.current?.dispose();
                cursorSubscriptionReference.current = editor.onDidChangeCursorSelection(() =>
                    publishEditorStatus(editor, statusKeyReference.current),
                );
                restoreEditorViewState(editor, editorInstanceId);
                registrationReference.current?.();
                registrationReference.current = registerEditorRevealTarget(
                    path,
                    editor,
                    editorInstanceId,
                );
                publishEditorStatus(editor, statusKeyReference.current);
                markEditorMounted();
            }}
            onChange={handleChange}
            options={{
                ...editorOptions,
                wordWrap: 'off',
                readOnly: readOnly === true,
                domReadOnly: readOnly === true,
                find: { addExtraSpaceOnTop: false },
            }}
        />
    );
}
