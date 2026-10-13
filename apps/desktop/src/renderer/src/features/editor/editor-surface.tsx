import {
    createElement,
    lazy,
    Suspense,
    useCallback,
    useEffect,
    useReducer,
    useSyncExternalStore,
} from 'react';

import {
    isExternalEditorTabPath,
    isSettingsTabPath,
    isUsageTabPath,
    parseAgentContextTab,
    parseAgentStatusTab,
    parseAgentTaskTab,
    parseAgentTranscriptTab,
    parseAgentTurnReviewTab,
    parseFilePreviewTab,
    parseGitDiffTab,
} from '@caxri/protocol';
import { editorModelPath } from '@desktop-shared/editor-state';

import { LoadingSkeleton, LoadingSkeletonScope } from '../../components/loading-skeleton';
import { useResourceLoad } from '../../hooks/use-resource-load';
import { translate, useTranslation } from '../../i18n';
import { describeDocumentReadFailure } from '../../lib/document-read-failure';
import { useTheme } from '../../stores/selectors';
import { sessionViewScope, useDocument } from '../../stores/session-view';
import { PREVIEW_LOADING_LABEL_KEY } from '../preview/preview-registry';
import { usePaneViewSession } from '../workbench/pane-view-session';
import type { CodeEditorProperties } from './code-editor';
import { cacheDocument, changeDocument } from './document-commands';
import { documentLoadRecoveryAction, documentReadRecovery } from './document-load-recovery';
import { EditorErrorBoundary } from './editor-error-boundary';
import { EditorLoadFailure } from './editor-load-failure';
import {
    EDITOR_LOAD_FAILURE_REASON_KEY,
    editorLoadReducer,
    initialEditorLoadState,
} from './editor-load-state';
import { getLoadedCodeEditor, loadCodeEditor, subscribeLoadedCodeEditor } from './editor-loader';
import { editorStatusKey } from './editor-status';
import { FileEditorBreadcrumbs } from './file-editor-breadcrumbs';

const GitDiffEditor = lazy(async () => {
    const module = await import('./git-diff-editor');
    return { default: module.GitDiffEditor };
});

const AgentTranscriptEditor = lazy(async () => {
    const module = await import('./agent-transcript-editor');
    return { default: module.AgentTranscriptEditor };
});

/**
 * Lazy so a Session that never opens a subagent or background shell tab does not load the Chat timeline for it.
 */
const AgentChatTaskTab = lazy(async () => {
    const module = await import('../agent-chat/agent-chat-task-tab');
    return { default: module.AgentChatTaskTab };
});

/**
 * Lazy for the same reason: only a turn review opened from a Chat needs it.
 */
const AgentChatTurnReviewTab = lazy(async () => {
    const module = await import('../agent-chat/agent-chat-turn-review-tab');
    return { default: module.AgentChatTurnReviewTab };
});

const AgentStatusPage = lazy(async () => {
    const module = await import('../agent-status/agent-status-page');
    return { default: module.AgentStatusPage };
});

const AgentContextPage = lazy(async () => {
    const module = await import('../agent-chat/context/agent-context-page');
    return { default: module.AgentContextPage };
});

/**
 * Lazy because a preview pulls in the Markdown engine, the sanitizer, and (on the first diagram) Mermaid. A Session
 * that never opens one must not pay for any of it.
 */
const PreviewSurface = lazy(async () => {
    const module = await import('../preview/preview-surface');
    return { default: module.PreviewSurface };
});

/**
 * Lazy for the same reason as the others above: Settings pulls in the whole config-editing form tree, the theme editor,
 * and the keybindings table, which a Session that never opens the tab must not pay for.
 */
const SettingsWorkbenchPage = lazy(async () => {
    const module = await import('../settings/settings-workbench-page');
    return { default: module.SettingsWorkbenchPage };
});

/**
 * Lazy so a Session that never opens the Usage report does not load its charts.
 */
const UsageWorkbenchPage = lazy(async () => {
    const module = await import('../usage/usage-workbench-page');
    return { default: module.UsageWorkbenchPage };
});

const emptyWorkClassName =
    'empty-work flex h-full flex-col items-center justify-center gap-3 text-muted';

function LoadedCodeEditor(properties: CodeEditorProperties) {
    const { t } = useTranslation();
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
                    reason: translate(EDITOR_LOAD_FAILURE_REASON_KEY),
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
                actionLabel={t('editor.load.reloadWindow')}
                reason={moduleLoad.reason}
                onAction={() => {
                    // A missing or stale asset is re-requested by the reload, and nothing is lost: durable workbench
                    // state lives in the Server, which is why `error-boundary.tsx` offers the same recovery.
                    location.reload();
                }}
            />
        );
    return <LoadingSkeleton variant="document" label={t('editor.load.loadingEditor')} />;
}

/**
 * Renders the focused editor tab. A tab whose content is not cached (restored from a previous run, or evicted by the
 * document cache cap) reads it on demand instead of being closed.
 */
function FileEditorSurface({ paneId, path }: { paneId: string; path: string }) {
    const { t } = useTranslation();
    const session = usePaneViewSession();
    const sessionId = session?.id;
    const scope = session ? sessionViewScope(session.id, session.workbenchProjectId) : undefined;
    const theme = useTheme();
    const document = useDocument(sessionId, path, session?.workbenchProjectId);
    const isExternal = isExternalEditorTabPath(path);
    const load = useCallback(
        () => (sessionId ? cacheDocument(sessionId, path) : Promise.resolve(undefined)),
        [path, sessionId],
    );
    const { failure, retry } = useResourceLoad({
        target: `${scope ?? ''}\u{0}${path}`,
        enabled: Boolean(sessionId && !document && !isExternal),
        load,
    });

    if (!session || !scope || !theme) return null;
    if (!document) {
        if (isExternal)
            return <div className={emptyWorkClassName}>{t('editor.load.externalUnavailable')}</div>;
        if (failure)
            return (
                <EditorLoadFailure
                    {...describeDocumentReadFailure(failure.error)}
                    {...documentLoadRecoveryAction(
                        documentReadRecovery(failure.error),
                        path,
                        retry,
                        t,
                    )}
                />
            );
        return <LoadingSkeleton variant="document" label={t('editor.load.loadingFile')} />;
    }
    return (
        <div className="flex h-full min-h-0 flex-col">
            <FileEditorBreadcrumbs
                paneId={paneId}
                path={path}
                displayPath={document.displayPath}
                isExternal={isExternal}
                readOnly={document.readOnly}
            />
            <div className="min-h-0 flex-1">
                <LoadedCodeEditor
                    editorInstanceId={paneId}
                    path={editorModelPath(scope, path)}
                    statusKey={editorStatusKey(scope, path)}
                    value={document.content}
                    theme={theme}
                    readOnly={document.readOnly}
                    onChange={(content) =>
                        changeDocument(session.id, session.workbenchProjectId, path, content ?? '')
                    }
                />
            </div>
        </div>
    );
}

/**
 * One loading scope per pane: opening a file reads it and then waits for the editor module, and those two placeholders
 * must read as one wait rather than a skeleton, a blank frame, and a second skeleton.
 */
export function EditorSurface({ paneId, path }: { paneId: string; path: string }) {
    return (
        <LoadingSkeletonScope>
            <EditorErrorBoundary resetKey={path}>
                <EditorSurfaceContent paneId={paneId} path={path} />
            </EditorErrorBoundary>
        </LoadingSkeletonScope>
    );
}

function EditorSurfaceContent({ paneId, path }: { paneId: string; path: string }) {
    const { t } = useTranslation();
    const gitDiffTab = parseGitDiffTab(path);
    if (gitDiffTab)
        return (
            <Suspense
                fallback={
                    <LoadingSkeleton
                        variant="document"
                        label={t('editor.load.loadingDiffEditor')}
                    />
                }
            >
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
            <Suspense
                fallback={
                    <LoadingSkeleton
                        variant="document"
                        label={t('editor.load.loadingTranscript')}
                    />
                }
            >
                <AgentTranscriptEditor key={transcriptTab.terminalId} tab={transcriptTab} />
            </Suspense>
        );
    const agentTaskTab = parseAgentTaskTab(path);
    if (agentTaskTab)
        return (
            <Suspense
                fallback={
                    <LoadingSkeleton variant="document" label={t('editor.load.loadingTask')} />
                }
            >
                <AgentChatTaskTab key={path} tab={agentTaskTab} />
            </Suspense>
        );
    const turnReviewTab = parseAgentTurnReviewTab(path);
    if (turnReviewTab)
        return (
            <Suspense
                fallback={
                    <LoadingSkeleton variant="document" label={t('editor.load.loadingChanges')} />
                }
            >
                <AgentChatTurnReviewTab key={path} tab={turnReviewTab} />
            </Suspense>
        );
    const agentStatusTab = parseAgentStatusTab(path);
    if (agentStatusTab)
        return (
            <Suspense
                fallback={
                    <LoadingSkeleton variant="page" label={t('editor.load.loadingAgentStatus')} />
                }
            >
                <AgentStatusPage key={path} terminalId={agentStatusTab.terminalId} />
            </Suspense>
        );
    const agentContextTab = parseAgentContextTab(path);
    if (agentContextTab)
        return (
            <Suspense
                fallback={
                    <LoadingSkeleton variant="page" label={t('editor.load.loadingAgentContext')} />
                }
            >
                <AgentContextPage key={path} terminalId={agentContextTab.terminalId} />
            </Suspense>
        );
    const previewTab = parseFilePreviewTab(path);
    if (previewTab)
        return (
            <Suspense
                fallback={
                    <LoadingSkeleton variant="document" label={t(PREVIEW_LOADING_LABEL_KEY)} />
                }
            >
                <PreviewSurface key={previewTab.path} paneId={paneId} tab={previewTab} />
            </Suspense>
        );
    if (isSettingsTabPath(path))
        return (
            <Suspense
                fallback={
                    <LoadingSkeleton variant="page" label={t('editor.load.loadingSettings')} />
                }
            >
                <SettingsWorkbenchPage />
            </Suspense>
        );
    if (isUsageTabPath(path))
        return (
            <Suspense
                fallback={<LoadingSkeleton variant="page" label={t('editor.load.loadingUsage')} />}
            >
                <UsageWorkbenchPage />
            </Suspense>
        );
    return <FileEditorSurface paneId={paneId} path={path} />;
}
