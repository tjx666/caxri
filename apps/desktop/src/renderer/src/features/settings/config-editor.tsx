import { useEffect, useRef } from 'react';

import type { ThemeTokens } from '@caxri/protocol';
import type { OnChange, OnMount } from '@monaco-editor/react';
import Editor from '@monaco-editor/react';

import { useEditorOptions } from '@/hooks/use-editor-options';

import { applyEditorTheme } from '../../lib/editor-theme';
import { configEditorClassName } from '../../lib/utilities';

interface ConfigEditorProperties {
    ariaLabel: string;
    path: string;
    theme: ThemeTokens;
    value: string;
    onBlur: () => void;
    onChange: (value: string) => void;
    goToLineRequest?: { line: number };
}

export function ConfigEditor({
    ariaLabel,
    path,
    theme,
    value,
    onBlur,
    onChange,
    goToLineRequest,
}: ConfigEditorProperties) {
    useEffect(() => applyEditorTheme(theme), [theme]);
    const editorOptions = useEditorOptions();

    // Monaco renders its own textarea, so `onMount` wires the blur-commit trigger directly to
    // that editable surface instead of the wrapping `<div>`. A ref keeps the callback current
    // across renders without re-mounting the editor: `onMount` only runs once, so a stale
    // closure over an early `onBlur` prop would keep committing against outdated state.
    const onBlurReference = useRef(onBlur);
    const editorReference = useRef<Parameters<OnMount>[0] | null>(null);
    const goToLineReference = useRef(goToLineRequest);
    useEffect(() => {
        onBlurReference.current = onBlur;
    }, [onBlur]);
    useEffect(() => {
        goToLineReference.current = goToLineRequest;
        if (goToLineRequest && editorReference.current)
            revealLine(editorReference.current, goToLineRequest.line);
    }, [goToLineRequest]);
    const handleMount: OnMount = (editor) => {
        editorReference.current = editor;
        editor.onDidBlurEditorText(() => onBlurReference.current());
        if (goToLineReference.current) revealLine(editor, goToLineReference.current.line);
    };

    return (
        <div className={configEditorClassName}>
            <Editor
                path={path}
                language="json"
                value={value}
                theme="caxri-active"
                beforeMount={() => applyEditorTheme(theme)}
                onChange={(next: Parameters<OnChange>[0]) => onChange(next ?? '')}
                onMount={handleMount}
                options={{
                    ...editorOptions,
                    ariaLabel,
                    fontSize: 12,
                    lineNumbersMinChars: 3,
                    tabSize: 2,
                    wordWrap: 'on',
                }}
            />
        </div>
    );
}

function revealLine(editor: Parameters<OnMount>[0], line: number): void {
    editor.setPosition({ lineNumber: line, column: 1 });
    editor.revealLineInCenter(line);
    editor.focus();
}
