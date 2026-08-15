import { createElement, lazy, Suspense, useEffect, useSyncExternalStore } from 'react';

import { editorModelPath } from '@shared/editor-state';
import { parseGitDiffTab } from '@shared/git-diff';

import { useSelectedSession, useTheme } from '../../stores/selectors';
import { sessionViewScope, useDocument } from '../../stores/session-view';
import { cacheDocument, changeDocument } from './document-actions';
import { getLoadedCodeEditor, loadCodeEditor, subscribeLoadedCodeEditor } from './editor-loader';
import type { CodeEditorProps } from './code-editor';
import { editorStatusKey } from './editor-status';

const GitDiffEditor = lazy(async () => {
    const module = await import('./git-diff-editor');
    return { default: module.GitDiffEditor };
});

const emptyWorkClassName =
    'empty-work flex h-full flex-col items-center justify-center gap-3 text-muted';

function LoadedCodeEditor(props: CodeEditorProps) {
    const CodeEditor = useSyncExternalStore(
        subscribeLoadedCodeEditor,
        getLoadedCodeEditor,
        getLoadedCodeEditor,
    );
    useEffect(() => {
        void loadCodeEditor().catch(() => undefined);
    }, []);
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
    const session = useSelectedSession();
    const sessionId = session?.id;
    const scope = session ? sessionViewScope(session.id, session.workbenchProjectId) : undefined;
    const theme = useTheme();
    const document = useDocument(sessionId, path, session?.workbenchProjectId);

    useEffect(() => {
        if (!sessionId || document) return;
        void cacheDocument(sessionId, path);
    }, [document, path, sessionId]);

    if (!sessionId || !scope || !theme) return null;
    if (!document) return <div className={emptyWorkClassName}>Loading file…</div>;
    return (
        <LoadedCodeEditor
            path={editorModelPath(scope, path)}
            statusKey={editorStatusKey(scope, path)}
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
