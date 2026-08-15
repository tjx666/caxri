import { useEffect, useRef } from 'react';

import type { OnMount } from '@monaco-editor/react';
import Editor from '@monaco-editor/react';
import type { ThemeTokens } from '@shared/types';

import { applyEditorTheme } from '../../lib/editor-theme';
import { monaco } from '../../lib/monaco';
import { resolveEditorLanguage } from './editor-language';
import { markEditorBeforeMount, markEditorMounted } from './editor-performance';
import { registerEditorRevealTarget } from './editor-reveal';
import { useEditorStatusStore } from './editor-status';

export interface CodeEditorProperties {
    path: string;
    statusKey?: string;
    value: string;
    theme: ThemeTokens;
    onChange: (content: string | undefined) => void;
}

type MonacoCodeEditor = Parameters<OnMount>[0];

function publishEditorStatus(editor: MonacoCodeEditor, statusKey: string | undefined): void {
    if (!statusKey) return;
    const model = editor.getModel();
    const selection = editor.getSelection();
    if (!model || !selection) return;
    const startOffset = model.getOffsetAt(selection.getStartPosition());
    const endOffset = model.getOffsetAt(selection.getEndPosition());
    useEditorStatusStore.getState().setStatus(statusKey, {
        line: selection.positionLineNumber,
        column: selection.positionColumn,
        selectedCharacters: Math.max(0, endOffset - startOffset),
        languageId: model.getLanguageId(),
    });
}

export function CodeEditor({ path, statusKey, value, theme, onChange }: CodeEditorProperties) {
    const editorReference = useRef<Parameters<OnMount>[0] | null>(null);
    const registrationReference = useRef<(() => void) | undefined>(undefined);
    const cursorSubscriptionReference = useRef<{ dispose(): void } | undefined>(undefined);
    const statusKeyReference = useRef(statusKey);
    const language = resolveEditorLanguage(path);
    useEffect(() => applyEditorTheme(theme), [theme]);
    useEffect(() => {
        const editor = editorReference.current;
        if (!editor) return;
        /**
         * Monaco 0.56 can leave a newly selected custom-language model un-tokenized while its
         * background scheduler is busy. Prime the registered Monarch grammar, then rebind the
         * model once per path so Monaco schedules tokenization for the visible model immediately.
         */
        const model = editor.getModel();
        if (language && model?.getLanguageId() === language) {
            monaco.editor.tokenize(model.getLineContent(1), language);
            monaco.editor.setModelLanguage(model, 'plaintext');
            monaco.editor.setModelLanguage(model, language);
        }
        registrationReference.current?.();
        const unregister = registerEditorRevealTarget(path, editor);
        registrationReference.current = unregister;
        return () => {
            unregister();
            if (registrationReference.current === unregister)
                registrationReference.current = undefined;
        };
    }, [language, path]);
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
            onMount={(editor) => {
                editorReference.current = editor;
                cursorSubscriptionReference.current?.dispose();
                cursorSubscriptionReference.current = editor.onDidChangeCursorSelection(() =>
                    publishEditorStatus(editor, statusKeyReference.current),
                );
                registrationReference.current?.();
                registrationReference.current = registerEditorRevealTarget(path, editor);
                publishEditorStatus(editor, statusKeyReference.current);
                markEditorMounted();
            }}
            onChange={onChange}
            options={{
                automaticLayout: true,
                minimap: { enabled: false },
                fontSize: 13,
                wordWrap: 'off',
                scrollBeyondLastLine: false,
                find: { addExtraSpaceOnTop: false },
            }}
        />
    );
}
