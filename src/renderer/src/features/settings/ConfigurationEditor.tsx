import Editor, { type OnMount } from '@monaco-editor/react';
import { useEffect, useRef } from 'react';

import type { ThemeTokens } from '@shared/types';

import { applyEditorTheme } from '../../lib/editor-theme';
import { configurationEditorClassName } from '../../lib/utils';

interface ConfigurationEditorProps {
    ariaLabel: string;
    path: string;
    theme: ThemeTokens;
    value: string;
    onBlur: () => void;
    onChange: (value: string) => void;
}

export function ConfigurationEditor({
    ariaLabel,
    path,
    theme,
    value,
    onBlur,
    onChange,
}: ConfigurationEditorProps) {
    useEffect(() => applyEditorTheme(theme), [theme]);

    // Monaco renders its own textarea, so `onMount` wires the blur-commit trigger directly to
    // that editable surface instead of the wrapping `<div>`. A ref keeps the callback current
    // across renders without re-mounting the editor: `onMount` only runs once, so a stale
    // closure over an early `onBlur` prop would keep committing against outdated state.
    const onBlurRef = useRef(onBlur);
    useEffect(() => {
        onBlurRef.current = onBlur;
    }, [onBlur]);
    const handleMount: OnMount = (editor) => {
        editor.onDidBlurEditorText(() => onBlurRef.current());
    };

    return (
        <div className={configurationEditorClassName}>
            <Editor
                path={path}
                language="json"
                value={value}
                theme="caxri-active"
                beforeMount={() => applyEditorTheme(theme)}
                onChange={(next) => onChange(next ?? '')}
                onMount={handleMount}
                options={{
                    ariaLabel,
                    automaticLayout: true,
                    fontSize: 12,
                    lineNumbersMinChars: 3,
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    tabSize: 2,
                    wordWrap: 'on',
                }}
            />
        </div>
    );
}
