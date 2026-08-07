import Editor, { type OnMount } from '@monaco-editor/react';
import { useEffect, useRef } from 'react';

import type { ThemeTokens } from '@shared/types';

import { applyEditorTheme } from '../../lib/editor-theme';
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
    useEffect(() => applyEditorTheme(theme), [theme]);
    useEffect(() => {
        const editor = editorRef.current;
        if (!editor) return;
        registrationRef.current?.();
        const unregister = registerEditorRevealTarget(path, editor);
        registrationRef.current = unregister;
        return () => {
            unregister();
            if (registrationRef.current === unregister) registrationRef.current = undefined;
        };
    }, [path]);
    return (
        <Editor
            path={path}
            language={resolveEditorLanguage(path)}
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
