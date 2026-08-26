import { useEffect, useRef } from 'react';

import type { ThemeTokens } from '@caxri/protocol';
import type { OnMount } from '@monaco-editor/react';
import Editor from '@monaco-editor/react';

import { useEditorFontFamily } from '@/hooks/use-editor-font-family';

import { applyEditorTheme } from '../../lib/editor-theme';
import { configEditorClassName } from '../../lib/utilities';

interface ConfigEditorProperties {
    ariaLabel: string;
    path: string;
    theme: ThemeTokens;
    value: string;
    onBlur: () => void;
    onChange: (value: string) => void;
}

export function ConfigEditor({
    ariaLabel,
    path,
    theme,
    value,
    onBlur,
    onChange,
}: ConfigEditorProperties) {
    useEffect(() => applyEditorTheme(theme), [theme]);
    const fontFamily = useEditorFontFamily();

    // Monaco renders its own textarea, so `onMount` wires the blur-commit trigger directly to
    // that editable surface instead of the wrapping `<div>`. A ref keeps the callback current
    // across renders without re-mounting the editor: `onMount` only runs once, so a stale
    // closure over an early `onBlur` prop would keep committing against outdated state.
    const onBlurReference = useRef(onBlur);
    useEffect(() => {
        onBlurReference.current = onBlur;
    }, [onBlur]);
    const handleMount: OnMount = (editor) => {
        editor.onDidBlurEditorText(() => onBlurReference.current());
    };

    return (
        <div className={configEditorClassName}>
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
                    ...(fontFamily && { fontFamily }),
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
