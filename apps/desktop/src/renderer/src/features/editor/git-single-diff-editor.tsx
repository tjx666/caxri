import './git-single-diff-editor.css';

import { useLayoutEffect, useState } from 'react';

import Editor from '@monaco-editor/react';
import type { editor as Monaco } from 'monaco-editor';

import { useEditorFontFamily } from '@/hooks/use-editor-font-family';

import type { SingleDiffKind } from './git-single-diff-binding';
import { bindSingleDiffEditor } from './git-single-diff-binding';

/**
 * Monaco diff models always contain at least one line, even for empty text. Its diff algorithm renders that empty line
 * as a removal/insertion. A single code editor preserves the actual document and avoids the phantom opposite hunk in
 * both wide and inline layouts. The wrapper owns this instance's unique model and disposes it on unmount.
 */
export function GitSingleDiffEditor({
    editorInstanceId,
    kind,
    language,
    modelPath,
    navigationKey,
    onContentHeightChange,
    value,
}: {
    editorInstanceId?: string;
    kind: SingleDiffKind;
    language: string | undefined;
    modelPath: string;
    navigationKey?: string;
    onContentHeightChange?: (height: number) => void;
    value: string;
}) {
    const [editor, setEditor] = useState<Monaco.IStandaloneCodeEditor | null>(null);
    const fontFamily = useEditorFontFamily();
    useLayoutEffect(() => {
        if (!editor) return;
        return bindSingleDiffEditor(editor, kind, {
            editorInstanceId,
            navigationKey,
            onContentHeightChange,
        });
    }, [editor, kind, editorInstanceId, navigationKey, onContentHeightChange]);
    return (
        <Editor
            className="git-single-diff-editor h-full w-full"
            language={language}
            path={modelPath}
            value={value}
            theme="caxri-active"
            onMount={setEditor}
            options={{
                ariaLabel: kind === 'added' ? 'Added file contents' : 'Deleted file contents',
                automaticLayout: true,
                ...(fontFamily && { fontFamily }),
                fontSize: 13,
                minimap: { enabled: false },
                readOnly: true,
                scrollBeyondLastLine: false,
                wordWrap: 'off',
                ...(onContentHeightChange && {
                    scrollbar: { alwaysConsumeMouseWheel: false },
                }),
            }}
        />
    );
}
