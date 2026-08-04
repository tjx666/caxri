import Editor from '@monaco-editor/react';
import { useEffect } from 'react';

import type { ThemeTokens } from '@shared/types';

import { applyEditorTheme } from '../lib/editor-theme';

interface CodeEditorProps {
    path: string;
    value: string;
    theme: ThemeTokens;
    onChange: (content: string | undefined) => void;
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
