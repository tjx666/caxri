import Editor, { type OnMount } from '@monaco-editor/react';
import { useEffect, useRef } from 'react';

import type { ThemeTokens } from '@shared/types';

import { applyEditorTheme } from '../../lib/editor-theme';
import { monaco } from '../../lib/monaco';
import { resolveEditorLanguage } from './editor-language';
import { markEditorBeforeMount, markEditorMounted } from './editor-performance';
import { registerEditorRevealTarget } from './editor-reveal';

export interface CodeEditorProps {
    path: string;
    value: string;
    theme: ThemeTokens;
    onChange: (content: string | undefined) => void;
}

export function CodeEditor({ path, value, theme, onChange }: CodeEditorProps) {
    const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
    const registrationRef = useRef<(() => void) | undefined>(undefined);
    const language = resolveEditorLanguage(path);
    useEffect(() => applyEditorTheme(theme), [theme]);
    useEffect(() => {
        const editor = editorRef.current;
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
        registrationRef.current?.();
        const unregister = registerEditorRevealTarget(path, editor);
        registrationRef.current = unregister;
        return () => {
            unregister();
            if (registrationRef.current === unregister) registrationRef.current = undefined;
        };
    }, [language, path]);
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
                editorRef.current = editor;
                registrationRef.current?.();
                registrationRef.current = registerEditorRevealTarget(path, editor);
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
