import './git-single-diff-editor.css';

import { useLayoutEffect, useState } from 'react';

import type { GitDiffDocument } from '@caxri/protocol';
import { gitDiffModelPath } from '@caxri/protocol';
import Editor from '@monaco-editor/react';
import type { editor as Monaco } from 'monaco-editor';

import { useEditorFontFamily } from '@/hooks/use-editor-font-family';

import { bindSingleDiffEditor } from './git-single-diff-binding';

/**
 * Monaco diff models always contain at least one line, even for empty text. Its diff algorithm renders that empty line
 * as a removal/insertion. A single code editor preserves the actual document and avoids the phantom opposite hunk in
 * both wide and inline layouts. The wrapper owns this instance's unique model and disposes it on unmount.
 */
export function GitSingleDiffEditor({
    document,
    editorInstanceId,
    modifiedLanguage,
    modelRepoId,
    navigationKey,
    onContentHeightChange,
    originalLanguage,
    sessionId,
}: {
    document: GitDiffDocument;
    editorInstanceId?: string;
    modifiedLanguage: string | undefined;
    modelRepoId: string;
    navigationKey?: string;
    onContentHeightChange?: (height: number) => void;
    originalLanguage: string | undefined;
    sessionId: string;
}) {
    const isAdded = document.original === '';
    const kind = isAdded ? 'added' : 'deleted';
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
            language={isAdded ? modifiedLanguage : originalLanguage}
            path={gitDiffModelPath(
                sessionId,
                modelRepoId,
                isAdded ? document.path : (document.originalPath ?? document.path),
                isAdded ? 'modified' : 'original',
            )}
            value={isAdded ? document.modified : document.original}
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
