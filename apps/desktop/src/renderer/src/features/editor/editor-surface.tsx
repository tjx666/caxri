import {
    createElement,
    lazy,
    Suspense,
    useEffect,
    useReducer,
    useState,
    useSyncExternalStore,
} from 'react';

import {
    isExternalEditorTabPath,
    parseAgentTranscriptTab,
    parseFilePreviewTab,
    parseGitDiffTab,
} from '@caxri/protocol';
import { editorModelPath } from '@desktop-shared/editor-state';
import { CircleSlash, TriangleAlert } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Empty, EmptyMedia, EmptyTitle } from '../../components/ui/empty';
import { useSelectedSession, useSelectedWorkbenchProject, useTheme } from '../../stores/selectors';
import { sessionViewScope, useDocument } from '../../stores/session-view';
import { describeFailure, isCancelledRequest } from '../../stores/toasts';
import type { CodeEditorProperties } from './code-editor';
import { cacheDocument, changeDocument } from './document-commands';
import { EditorBreadcrumbs } from './editor-breadcrumbs';
import { EditorHeadBlame } from './editor-head-blame';
import type { EditorLoadTone } from './editor-load-state';
import { editorLoadReducer, initialEditorLoadState } from './editor-load-state';
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

/**
 * Lazy because a preview pulls in the Markdown engine, the sanitizer, and — on the first diagram — Mermaid. A Session
 * that never opens one must not pay for any of it.
 */
const PreviewSurface = lazy(async () => {
    const module = await import('../preview/preview-surface');
    return { default: module.PreviewSurface };
});

const emptyWorkClassName =
    'empty-work flex h-full flex-col items-center justify-center gap-3 text-muted';

/**
 * A failed chunk load carries no cause a user can act on — the file it names is a build asset, not their document — so
 * the recovery sentence replaces the technical one instead of quoting it.
 */
const EDITOR_LOAD_FAILURE_REASON = "The editor didn't load. Reloading the window usually fixes it.";

/**
 * Opening sentence of the document failure. `describeFailure` appends the concrete cause behind it (the file is gone,
 * permission was denied, and so on), which is the part that tells the user whether retrying can help.
 */
const DOCUMENT_READ_FAILURE_LABEL = "Couldn't open this file";

/**
 * A cancelled read is not a failure the user can act on — Main refuses queued Renderer work once quit starts, and the
 * Host client cancels everything in flight when a lease is replaced — so it is never dressed up as one
 * (`isCancelledRequest` documents the same rule for toasts). It still may not leave the spinner running forever,
 * because nothing re-issues the read afterwards, so it gets a neutral state that offers the retry.
 */
const DOCUMENT_READ_INTERRUPTED_REASON = 'Opening this file was interrupted.';

function describeDocumentReadFailure(error: unknown): { reason: string; tone: EditorLoadTone } {
    return isCancelledRequest(error)
        ? { reason: DOCUMENT_READ_INTERRUPTED_REASON, tone: 'interrupted' }
        : { reason: describeFailure(error, DOCUMENT_READ_FAILURE_LABEL), tone: 'failed' };
}

/**
 * Shared shape for the editor area's non-happy states: what happened, in plain language, plus the one action that can
 * recover from it. A real failure is announced through `role="alert"` because the surface it replaces was a spinner the
 * user was already watching; an interruption is not, since the user did not ask for anything to go wrong and nothing
 * about it is urgent.
 */
function EditorLoadFailure({
    actionLabel,
    reason,
    tone = 'failed',
    onAction,
}: {
    actionLabel: string;
    reason: string;
    tone?: EditorLoadTone;
    onAction: () => void;
}) {
    const isFailure = tone === 'failed';
    return (
        <Empty className="empty-work h-full flex-1" role={isFailure ? 'alert' : undefined}>
            <EmptyMedia>
                {isFailure ? (
                    <TriangleAlert aria-hidden="true" className="text-danger" size={28} />
                ) : (
                    <CircleSlash aria-hidden="true" className="text-muted" size={28} />
                )}
            </EmptyMedia>
            <EmptyTitle className="max-w-80 text-pretty">{reason}</EmptyTitle>
            <Button size="sm" variant="secondary" onClick={onAction}>
                {actionLabel}
            </Button>
        </Empty>
    );
}

function LoadedCodeEditor(properties: CodeEditorProperties) {
    const CodeEditor = useSyncExternalStore(
        subscribeLoadedCodeEditor,
        getLoadedCodeEditor,
        getLoadedCodeEditor,
    );
    const [moduleLoad, dispatchModuleLoad] = useReducer(editorLoadReducer, initialEditorLoadState);
    const attempt = moduleLoad.attempt;
    useEffect(() => {
        let isDisposed = false;
        // Fire-and-forget: the outcome is reported through the reducer rather than awaited. A failed dynamic import
        // leaves `CodeEditor` unset, so without this the "Loading editor…" fallback stayed on screen forever.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void loadCodeEditor().catch(() => {
            // Only the failure is recorded: success arrives through the `getLoadedCodeEditor` subscription above, which
            // renders the editor before this state is ever consulted.
            if (!isDisposed)
                dispatchModuleLoad({
                    type: 'failed',
                    attempt,
                    reason: EDITOR_LOAD_FAILURE_REASON,
                    tone: 'failed',
                });
        });
        return () => {
            isDisposed = true;
        };
    }, [attempt]);
    if (CodeEditor) return createElement(CodeEditor, properties);
    if (moduleLoad.status === 'failed')
        return (
            <EditorLoadFailure
                actionLabel="Reload window"
                reason={moduleLoad.reason}
                onAction={() => {
                    // A missing or stale asset is re-requested by the reload, and nothing is lost: durable workbench
                    // state lives in the Server, which is why `error-boundary.tsx` offers the same recovery.
                    location.reload();
                }}
            />
        );
    return <div className={emptyWorkClassName}>Loading editor…</div>;
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
    const [documentLoad, dispatchDocumentLoad] = useReducer(
        editorLoadReducer,
        initialEditorLoadState,
    );
    const attempt = documentLoad.attempt;

    /**
     * The pane keeps this component mounted across tab switches, so a failure recorded for the previous file has to be
     * dropped before the next one reports anything. Done during render rather than in an effect: React restarts the
     * render immediately without painting, while an effect runs after the browser may already have shown one frame of
     * the previous file's error sitting over the new file's tab.
     */
    const target = `${sessionId ?? ''}\u{0}${path}`;
    const [renderedTarget, setRenderedTarget] = useState(target);
    if (renderedTarget !== target) {
        setRenderedTarget(target);
        dispatchDocumentLoad({ type: 'restarted' });
    }

    useEffect(() => {
        if (!sessionId || document || isExternal) return;
        let isDisposed = false;
        // Fire-and-forget: `cacheDocument` still funnels its own failures into a toast via `tryCommand`, and hands the
        // rejection back so the surface can show it too. The toast expires after four seconds; this state does not.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void cacheDocument(sessionId, path)
            .then((failure) => {
                if (isDisposed) return;
                dispatchDocumentLoad(
                    failure
                        ? {
                              type: 'failed',
                              attempt,
                              ...describeDocumentReadFailure(failure.error),
                          }
                        : { type: 'succeeded', attempt },
                );
            })
            .catch((error: unknown) => {
                // `cacheDocument` resolves rather than rejects for every failure it expects; this keeps an unexpected
                // one out of the endless spinner as well.
                if (!isDisposed)
                    dispatchDocumentLoad({
                        type: 'failed',
                        attempt,
                        ...describeDocumentReadFailure(error),
                    });
            });
        return () => {
            isDisposed = true;
        };
    }, [attempt, document, isExternal, path, sessionId]);

    if (!sessionId || !scope || !theme) return null;
    if (!document) {
        if (isExternal)
            return <div className={emptyWorkClassName}>External file is no longer available.</div>;
        if (documentLoad.status === 'failed')
            return (
                <EditorLoadFailure
                    actionLabel="Retry"
                    reason={documentLoad.reason}
                    tone={documentLoad.tone}
                    onAction={() => {
                        dispatchDocumentLoad({ type: 'retried' });
                    }}
                />
            );
        return <div className={emptyWorkClassName}>Loading file…</div>;
    }
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
                {/*
                 * Keyed per diff resource so switching between two diff tabs in one pane remounts the editor instead
                 * of re-pointing a live one. `@monaco-editor/react`'s DiffEditor swaps a changed model path only on
                 * the inner editors, but Monaco's `DiffEditorWidget.getModel()` still answers with the pair it was
                 * mounted with, so the wrapper's `original` update effect writes the new tab's original text into
                 * the previous tab's model and the diff keeps being computed against that stale pair.
                 */}
                <GitDiffEditor key={path} paneId={paneId} tab={gitDiffTab} tabPath={path} />
            </Suspense>
        );
    const transcriptTab = parseAgentTranscriptTab(path);
    if (transcriptTab)
        return (
            <Suspense fallback={<div className={emptyWorkClassName}>Loading transcript…</div>}>
                <AgentTranscriptEditor key={transcriptTab.terminalId} tab={transcriptTab} />
            </Suspense>
        );
    const previewTab = parseFilePreviewTab(path);
    if (previewTab)
        return (
            <Suspense fallback={<div className={emptyWorkClassName}>Loading preview…</div>}>
                <PreviewSurface key={previewTab.path} tab={previewTab} />
            </Suspense>
        );
    return <FileEditorSurface paneId={paneId} path={path} />;
}
