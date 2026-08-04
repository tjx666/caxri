import Editor from '@monaco-editor/react';
import { useEffect } from 'react';

import type { ThemeTokens } from '@shared/types';

import { monaco } from '../lib/monaco';

interface CodeEditorProps {
    path: string;
    value: string;
    theme: ThemeTokens;
    onChange: (content: string | undefined) => void;
}

function applyEditorTheme(theme: ThemeTokens): void {
    monaco.editor.defineTheme('caxri-active', {
        base: 'vs-dark',
        inherit: true,
        rules: [
            { token: 'comment', foreground: theme.editor.comment.slice(1) },
            { token: 'keyword', foreground: theme.editor.keyword.slice(1) },
            { token: 'string', foreground: theme.editor.string.slice(1) },
            { token: 'number', foreground: theme.editor.number.slice(1) },
        ],
        colors: {
            'editor.background': theme.editor.background,
            'editor.foreground': theme.editor.foreground,
            'editor.lineHighlightBackground': theme.editor.lineHighlight,
            'editor.selectionBackground': theme.editor.selection,
        },
    });
    monaco.editor.setTheme('caxri-active');
}

export default function CodeEditor({ path, value, theme, onChange }: CodeEditorProps) {
    useEffect(() => applyEditorTheme(theme), [theme]);
    return (
        <Editor
            path={path}
            value={value}
            theme="caxri-active"
            beforeMount={() => applyEditorTheme(theme)}
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
