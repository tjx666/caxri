import { createElement, lazy, Suspense, useEffect, useSyncExternalStore } from 'react';

import { isExternalEditorTabPath, parseAgentTranscriptTab, parseGitDiffTab } from '@caxri/protocol';
import { editorModelPath } from '@desktop-shared/editor-state';

import { useSelectedSession, useSelectedWorkbenchProject, useTheme } from '../../stores/selectors';
import { sessionViewScope, useDocument } from '../../stores/session-view';
import type { CodeEditorProperties } from './code-editor';
import { cacheDocument, changeDocument } from './document-actions';
import { EditorBreadcrumbs } from './editor-breadcrumbs';
import { EditorHeadBlame } from './editor-head-blame';
import { getLoadedCodeEditor, loadCodeEditor, subscribeLoadedCodeEditor } from './editor-loader';
import { editorStatusKey } from './editor-status';

const GitDiffEditor = lazy(async () => {
    const module = await import('./git-diff-editor');
    return { default: module.GitDiffEditor };
});

const AgentTranscriptEditor = lazy(async () => {
    const module = await import('./agent-transcript-editor');
    return { default: module.AgentTranscriptEditor };
});

const emptyWorkClassName =
    'empty-work flex h-full flex-col items-center justify-center gap-3 text-muted';

async function loadCodeEditorIgnoringFailure(): Promise<void> {
    try {
        await loadCodeEditor();
    } catch {
        // ignored: see the call site's eslint-disable comment.
    }
}

function LoadedCodeEditor(properties: CodeEditorProperties) {
    const CodeEditor = useSyncExternalStore(
        subscribeLoadedCodeEditor,
        getLoadedCodeEditor,
        getLoadedCodeEditor,
    );
    useEffect(() => {
        // Fire-and-forget: a failed dynamic import leaves `CodeEditor` unset and the "Loading
        // editor…" fallback below stays visible; there is no separate error UI to report into.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void loadCodeEditorIgnoringFailure();
    }, []);
    return CodeEditor ? (
        createElement(CodeEditor, properties)
    ) : (
        <div className={emptyWorkClassName}>Loading editor…</div>
    );
}

/**
 * Renders the focused editor tab. A tab whose content is not cached — restored from a previous run, or evicted by the
 * document cache cap — reads it on demand instead of being closed.
 */
function FileEditorSurface({ paneId, path }: { paneId: string; path: string }) {
    const session = useSelectedSession();
    const sessionId = session?.id;
    const scope = session ? sessionViewScope(session.id, session.workbenchProjectId) : undefined;
    const project = useSelectedWorkbenchProject();
    const theme = useTheme();
    const document = useDocument(sessionId, path, session?.workbenchProjectId);
    const isExternal = isExternalEditorTabPath(path);

    useEffect(() => {
        if (!sessionId || document || isExternal) return;
        // Fire-and-forget: `cacheDocument` funnels its own failures into a toast via `tryCommand`,
        // so there is nothing left for this effect to await or react to.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void cacheDocument(sessionId, path);
    }, [document, isExternal, path, sessionId]);

    if (!sessionId || !scope || !theme) return null;
    if (!document)
        return (
            <div className={emptyWorkClassName}>
                {isExternal ? 'External file is no longer available.' : 'Loading file…'}
            </div>
        );
    return (
        <div className="flex h-full min-h-0 flex-col">
            {!isExternal && (
                <div className="flex h-6 shrink-0 items-center overflow-hidden border-b border-border bg-surface">
                    {project && (
                        <EditorBreadcrumbs
                            paneId={paneId}
                            path={path}
                            projectRoot={project.rootPath}
                            sessionId={sessionId}
                            workbenchProjectId={session.workbenchProjectId}
                        />
                    )}
                    <EditorHeadBlame path={path} sessionId={sessionId} />
                </div>
            )}
            <div className="min-h-0 flex-1">
                <LoadedCodeEditor
                    editorInstanceId={paneId}
                    path={editorModelPath(scope, path)}
                    statusKey={editorStatusKey(scope, path)}
                    value={document.content}
                    theme={theme}
                    readOnly={document.readOnly}
                    onChange={(content) => changeDocument(path, content ?? '')}
                />
            </div>
        </div>
    );
}

export function EditorSurface({ paneId, path }: { paneId: string; path: string }) {
    const gitDiffTab = parseGitDiffTab(path);
    if (gitDiffTab)
        return (
            <Suspense fallback={<div className={emptyWorkClassName}>Loading diff editor…</div>}>
                <GitDiffEditor paneId={paneId} tab={gitDiffTab} tabPath={path} />
            </Suspense>
        );
    const transcriptTab = parseAgentTranscriptTab(path);
    if (transcriptTab)
        return (
            <Suspense fallback={<div className={emptyWorkClassName}>Loading transcript…</div>}>
                <AgentTranscriptEditor key={transcriptTab.terminalId} tab={transcriptTab} />
            </Suspense>
        );
    return <FileEditorSurface paneId={paneId} path={path} />;
}
