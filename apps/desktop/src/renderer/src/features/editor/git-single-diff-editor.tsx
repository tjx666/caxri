import './git-single-diff-editor.css';

import { useLayoutEffect, useState } from 'react';

import type { GitDiffDocument } from '@caxri/protocol';
import { gitDiffModelPath } from '@caxri/protocol';
import Editor from '@monaco-editor/react';
import type { editor as Monaco } from 'monaco-editor';

import { useEditorOptions } from '@/hooks/use-editor-options';

import { bindGitReviewCommentEditor } from './git-review-comment-binding';
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
    repositoryId,
    sessionId,
    sourceKey,
}: {
    document: GitDiffDocument;
    editorInstanceId?: string;
    modifiedLanguage: string | undefined;
    modelRepoId: string;
    navigationKey?: string;
    onContentHeightChange?: (height: number) => void;
    originalLanguage: string | undefined;
    repositoryId: string;
    sessionId: string;
    sourceKey: string;
}) {
    const isAdded = document.original === '';
    const kind = isAdded ? 'added' : 'deleted';
    const [editor, setEditor] = useState<Monaco.IStandaloneCodeEditor | null>(null);
    const editorOptions = useEditorOptions();
    useLayoutEffect(() => {
        if (!editor) return;
        const unbindDiff = bindSingleDiffEditor(editor, kind, {
            editorInstanceId,
            navigationKey,
            onContentHeightChange,
        });
        const unbindReview = bindGitReviewCommentEditor(editor, {
            sessionId,
            repositoryId,
            sourceKey,
            path: isAdded ? document.path : (document.originalPath ?? document.path),
            side: isAdded ? 'modified' : 'original',
        });
        return () => {
            unbindReview();
            unbindDiff();
        };
    }, [
        editor,
        kind,
        editorInstanceId,
        navigationKey,
        onContentHeightChange,
        sessionId,
        repositoryId,
        sourceKey,
        document.path,
        document.originalPath,
        isAdded,
    ]);
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
                ...editorOptions,
                glyphMargin: true,
                ariaLabel: kind === 'added' ? 'Added file contents' : 'Deleted file contents',
                readOnly: true,
                wordWrap: 'off',
                ...(onContentHeightChange && {
                    scrollbar: { alwaysConsumeMouseWheel: false },
                }),
            }}
        />
    );
}
