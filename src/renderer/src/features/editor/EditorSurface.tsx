import { createElement, lazy, Suspense, useEffect, useSyncExternalStore } from 'react';

import { editorModelPath } from '@shared/editor-state';
import { parseGitDiffTab } from '@shared/git-diff';

import { useSelectedSession, useTheme } from '../../stores/selectors';
import { useDocument } from '../../stores/session-view';
import { cacheDocument, changeDocument } from './document-actions';
import { getLoadedCodeEditor, loadCodeEditor, subscribeLoadedCodeEditor } from './editor-loader';
import type { CodeEditorProps } from './CodeEditor';

const GitDiffEditor = lazy(() => import('./GitDiffEditor'));

const emptyWorkClassName =
    'empty-work flex h-full flex-col items-center justify-center gap-3 text-muted';

function LoadedCodeEditor(props: CodeEditorProps) {
    const CodeEditor = useSyncExternalStore(
        subscribeLoadedCodeEditor,
        getLoadedCodeEditor,
        getLoadedCodeEditor,
    );
    useEffect(() => {
        if (!CodeEditor) void loadCodeEditor().catch(() => undefined);
    }, [CodeEditor]);
    return CodeEditor ? (
        createElement(CodeEditor, props)
    ) : (
        <div className={emptyWorkClassName}>Loading editor…</div>
    );
}

/**
 * Renders the focused editor tab. A tab whose content is not cached — restored from a previous run,
 * or evicted by the document cache cap — reads it on demand instead of being closed.
 */
function FileEditorSurface({ path }: { path: string }) {
    const sessionId = useSelectedSession()?.id;
    const theme = useTheme();
    const document = useDocument(sessionId, path);

    useEffect(() => {
        if (!sessionId || document) return;
        void cacheDocument(sessionId, path);
    }, [document, path, sessionId]);

    if (!sessionId || !theme) return null;
    if (!document) return <div className={emptyWorkClassName}>Loading file…</div>;
    return (
        <LoadedCodeEditor
            path={editorModelPath(sessionId, path)}
            value={document.content}
            theme={theme}
            onChange={(content) => changeDocument(path, content ?? '')}
        />
    );
}

export function EditorSurface({ path }: { path: string }) {
    const gitDiffTab = parseGitDiffTab(path);
    if (gitDiffTab)
        return (
            <Suspense fallback={<div className={emptyWorkClassName}>Loading diff editor…</div>}>
                <GitDiffEditor tab={gitDiffTab} />
            </Suspense>
        );
    return <FileEditorSurface path={path} />;
}
