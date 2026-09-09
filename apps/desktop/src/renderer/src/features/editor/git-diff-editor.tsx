import type { ReactElement, RefObject } from 'react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

import type { GitDiffDocument, GitDiffTab, GitFileStatus } from '@caxri/protocol';
import { gitDiffModelPath } from '@caxri/protocol';
import { pathBasename } from '@caxri/utils';
import type { DiffOnMount, MonacoDiffEditor, OnMount } from '@monaco-editor/react';
import Editor from '@monaco-editor/react';
import { ChevronDown, ChevronRight, FileSymlink } from 'lucide-react';

import { useEditorFontFamily } from '@/hooks/use-editor-font-family';

import { GitFileStatusLetter } from '../../components/git-file-status-letter';
import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';
import { FileTypeIcon } from '../../icons/files/file-type-icon';
import { applyEditorTheme } from '../../lib/editor-theme';
import { monaco } from '../../lib/monaco';
import { useCaxriQuery, useToastOnQueryError } from '../../queries/client';
import { useSelectedSession, useTheme } from '../../stores/selectors';
import { describeFailure } from '../../stores/toasts';
import { openFile } from './document-actions';
import { resolveRegisteredEditorLanguage } from './editor-language';
import { GitChangesDiffList } from './git-changes-diff-list';
import { registerDiffEditorActions } from './git-diff-actions';
import { observeGitEditorContentHeight } from './git-diff-model-lifecycle';
import { GitMonacoDiffEditor } from './git-monaco-diff-editor';
import { GitSingleDiffEditor } from './git-single-diff-editor';

const emptyWorkClassName =
    'empty-work flex h-full flex-col items-center justify-center gap-3 text-muted';
const gitMultiDiffPlaceholderClassName =
    'git-multi-diff-placeholder grid h-[360px] place-items-center text-muted text-[11px]';
const gitMultiDiffErrorClassName =
    'git-multi-diff-error grid place-items-center py-8 text-danger text-[11px]';

/**
 * Stacked editors grow to their diff's content height so only the outer list scrolls, but a pathological diff (a
 * rewritten lockfile, a generated bundle) is capped here: past the ceiling the editor keeps its own scrollbar, and
 * `alwaysConsumeMouseWheel: false` still hands the wheel back to the outer list at the edges.
 */
const maxStackedEditorHeight = 4000;
const initialStackedEditorHeight = 360;

function useNearMultiDiffViewport(): {
    active: boolean;
    containerRef: RefObject<HTMLElement | null>;
} {
    const containerReference = useRef<HTMLElement | null>(null);
    const [active, setActive] = useState(false);
    useEffect(() => {
        const element = containerReference.current;
        if (!element || typeof IntersectionObserver === 'undefined') {
            setActive(true);
            return;
        }
        const observer = new IntersectionObserver(([entry]) => setActive(entry.isIntersecting), {
            root: element.closest('.git-multi-diff'),
            rootMargin: '720px 0px',
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, []);
    return { active, containerRef: containerReference };
}

/**
 * Callers key the content shape so swapping single/double-sided editors fully releases the previous models.
 */
function DiffSurface({
    contentHeight,
    document,
    editorInstanceId,
    navigationKey,
    onContentHeightChange,
    repositoryId,
    sessionId,
    source,
    stacked = false,
}: {
    /**
     * Owned by the multi-diff item (not locally) so the remembered height survives the editor being virtualized out of
     * the near-viewport window — a 360px reset there would yank the outer scroll position every time an item unmounts.
     */
    contentHeight?: number;
    document: GitDiffDocument;
    editorInstanceId?: string;
    navigationKey?: string;
    onContentHeightChange?: (height: number) => void;
    repositoryId: string;
    sessionId: string;
    source: GitDiffTab['source'];
    /**
     * Multi-file changes mode: the editor sizes itself to its diff content (collapsing unchanged regions, VS Code
     * multi-diff style) instead of filling the parent, so the outer list owns scrolling and the wheel is never captured
     * by an inner editor that already fits.
     */
    stacked?: boolean;
}) {
    const theme = useTheme();
    const editorReference = useRef<MonacoDiffEditor | null>(null);
    const diffEditorRegistrationReference = useRef<(() => void) | undefined>(undefined);
    const fontFamily = useEditorFontFamily();
    const contentSizeListeners = useRef<Array<{ dispose(): void }>>([]);
    useEffect(() => {
        if (theme) applyEditorTheme(theme);
    }, [theme]);
    useLayoutEffect(
        () => () => {
            /**
             * Dispose the content-size listeners first so `setModel(null)` below cannot re-enter the height callback (a
             * parent setState) while this component is unmounting.
             */
            for (const listener of contentSizeListeners.current) listener.dispose();
            contentSizeListeners.current = [];
            diffEditorRegistrationReference.current?.();
            diffEditorRegistrationReference.current = undefined;
            editorReference.current = null;
        },
        [],
    );
    useEffect(() => {
        const editor = editorReference.current;
        if (!editor || !navigationKey || !editorInstanceId) return;
        diffEditorRegistrationReference.current?.();
        diffEditorRegistrationReference.current = registerDiffEditorActions(
            navigationKey,
            editorInstanceId,
            editor,
        );
        return () => {
            diffEditorRegistrationReference.current?.();
            diffEditorRegistrationReference.current = undefined;
        };
    }, [editorInstanceId, navigationKey]);
    /**
     * Per-instance model paths: the same file can be open as a single-file diff tab and inside a multi-diff list (or in
     * two panes) at once, and Monaco resolves `getOrCreateModel` by path, so a shared path would make one surface's
     * unmount dispose the models the other is still showing.
     */
    const surfaceId = useId();
    if (!theme) return null;
    const modelRepoId = `${source}:${repositoryId}:${surfaceId}`;
    const registrations = monaco.languages.getLanguages();
    const originalLanguage = resolveRegisteredEditorLanguage(
        document.originalPath ?? document.path,
        registrations,
    );
    const modifiedLanguage = resolveRegisteredEditorLanguage(document.path, registrations);
    const withStackedSurface = (editorElement: ReactElement): ReactElement =>
        stacked ? (
            <div
                className="git-multi-diff-surface overflow-hidden"
                style={{
                    height: Math.min(
                        contentHeight ?? initialStackedEditorHeight,
                        maxStackedEditorHeight,
                    ),
                }}
            >
                {editorElement}
            </div>
        ) : (
            editorElement
        );
    if (
        document.format === 'contents' &&
        (document.original === '') !== (document.modified === '')
    ) {
        return withStackedSurface(
            <GitSingleDiffEditor
                document={document}
                editorInstanceId={editorInstanceId}
                modifiedLanguage={modifiedLanguage}
                modelRepoId={modelRepoId}
                navigationKey={navigationKey}
                onContentHeightChange={stacked ? onContentHeightChange : undefined}
                originalLanguage={originalLanguage}
                sessionId={sessionId}
            />,
        );
    }
    if (document.format === 'patch')
        return withStackedSurface(
            <Editor
                className="git-patch-editor h-full w-full"
                language="diff"
                path={`${gitDiffModelPath(sessionId, modelRepoId, document.path, 'modified')}.diff`}
                value={document.modified}
                theme="caxri-active"
                beforeMount={() => applyEditorTheme(theme)}
                onMount={(editor: Parameters<OnMount>[0]) => {
                    if (!stacked) return;
                    contentSizeListeners.current.push(
                        ...observeGitEditorContentHeight([editor], editor, onContentHeightChange),
                    );
                }}
                options={{
                    automaticLayout: true,
                    ...(fontFamily && { fontFamily }),
                    fontSize: 13,
                    minimap: { enabled: false },
                    readOnly: true,
                    scrollBeyondLastLine: false,
                    wordWrap: 'off',
                    ...(stacked && { scrollbar: { alwaysConsumeMouseWheel: false } }),
                }}
            />,
        );
    return withStackedSurface(
        <GitMonacoDiffEditor
            stacked={stacked}
            original={document.original}
            modified={document.modified}
            originalLanguage={originalLanguage}
            modifiedLanguage={modifiedLanguage}
            originalModelPath={gitDiffModelPath(
                sessionId,
                modelRepoId,
                document.originalPath ?? document.path,
                'original',
            )}
            modifiedModelPath={gitDiffModelPath(sessionId, modelRepoId, document.path, 'modified')}
            theme="caxri-active"
            beforeMount={() => applyEditorTheme(theme)}
            onMount={(editor: Parameters<DiffOnMount>[0]) => {
                editorReference.current = editor;
                diffEditorRegistrationReference.current?.();
                diffEditorRegistrationReference.current =
                    navigationKey && editorInstanceId
                        ? registerDiffEditorActions(navigationKey, editorInstanceId, editor)
                        : undefined;
                if (!stacked) return;
                const original = editor.getOriginalEditor();
                const modified = editor.getModifiedEditor();
                contentSizeListeners.current.push(
                    ...observeGitEditorContentHeight(
                        [original, modified],
                        modified,
                        onContentHeightChange,
                    ),
                );
            }}
            options={{
                automaticLayout: true,
                ...(fontFamily && { fontFamily }),
                fontSize: 13,
                minimap: { enabled: false },
                originalEditable: false,
                readOnly: true,
                scrollBeyondLastLine: false,
                wordWrap: 'off',
                ...(stacked && {
                    scrollbar: { alwaysConsumeMouseWheel: false },
                }),
            }}
        />,
    );
}

function FileDiffResult({
    document,
    editorInstanceId,
    error,
    isError,
    navigationKey,
    sessionId,
    tab,
}: {
    document?: GitDiffDocument;
    editorInstanceId: string;
    error: Error | null;
    isError: boolean;
    navigationKey: string;
    sessionId?: string;
    tab: Extract<GitDiffTab, { kind: 'commit-file' | 'file' }>;
}) {
    useToastOnQueryError(isError, error, 'Unable to open Git diff');
    if (!sessionId) return null;
    if (isError)
        return (
            <div className={emptyWorkClassName}>
                {describeFailure(error, 'Unable to open Git diff')}
            </div>
        );
    if (!document) return <div className={emptyWorkClassName}>Loading diff…</div>;
    return (
        <div className="git-file-diff absolute inset-0 overflow-hidden">
            <DiffSurface
                key={`${document.format}:${!document.original}:${!document.modified}`}
                document={document}
                editorInstanceId={editorInstanceId}
                navigationKey={navigationKey}
                repositoryId={tab.repositoryId}
                sessionId={sessionId}
                source={tab.source}
            />
        </div>
    );
}

function WorkingFileDiffEditor({
    editorInstanceId,
    navigationKey,
    tab,
}: {
    editorInstanceId: string;
    navigationKey: string;
    tab: Extract<GitDiffTab, { kind: 'file' }>;
}) {
    const sessionId = useSelectedSession()?.id;
    const {
        data: document,
        isError,
        error,
    } = useCaxriQuery(
        'git.diffDocument',
        { sessionId: sessionId ?? '', repositoryId: tab.repositoryId, path: tab.path },
        { enabled: Boolean(sessionId) },
    );
    return (
        <FileDiffResult
            document={document}
            editorInstanceId={editorInstanceId}
            error={error}
            isError={isError}
            navigationKey={navigationKey}
            sessionId={sessionId}
            tab={tab}
        />
    );
}

function PullRequestFileDiffEditor({
    editorInstanceId,
    navigationKey,
    tab,
}: {
    editorInstanceId: string;
    navigationKey: string;
    tab: Extract<GitDiffTab, { kind: 'file' }>;
}) {
    const sessionId = useSelectedSession()?.id;
    const {
        data: document,
        isError,
        error,
    } = useCaxriQuery(
        'git.pullRequestDiffDocument',
        { sessionId: sessionId ?? '', repositoryId: tab.repositoryId, path: tab.path },
        { enabled: Boolean(sessionId) },
    );
    return (
        <FileDiffResult
            document={document}
            editorInstanceId={editorInstanceId}
            error={error}
            isError={isError}
            navigationKey={navigationKey}
            sessionId={sessionId}
            tab={tab}
        />
    );
}

function CommitFileDiffEditor({
    editorInstanceId,
    navigationKey,
    tab,
}: {
    editorInstanceId: string;
    navigationKey: string;
    tab: Extract<GitDiffTab, { kind: 'commit-file' }>;
}) {
    const sessionId = useSelectedSession()?.id;
    const {
        data: document,
        isError,
        error,
    } = useCaxriQuery(
        'git.commitDiffDocument',
        {
            sessionId: sessionId ?? '',
            repositoryId: tab.repositoryId,
            sha: tab.sha,
            path: tab.path,
        },
        // A commit is immutable under its sha, so the resolved diff never goes stale.
        { enabled: Boolean(sessionId), staleTime: Infinity },
    );
    return (
        <FileDiffResult
            document={document}
            editorInstanceId={editorInstanceId}
            error={error}
            isError={isError}
            navigationKey={navigationKey}
            sessionId={sessionId}
            tab={tab}
        />
    );
}

function GitChangesDiffResult({
    contentHeight,
    document,
    error,
    isError,
    onContentHeightChange,
    repositoryId,
    sessionId,
    source,
}: {
    contentHeight?: number;
    document?: GitDiffDocument;
    error: Error | null;
    isError: boolean;
    onContentHeightChange?: (height: number) => void;
    repositoryId: string;
    sessionId: string;
    source: GitDiffTab['source'];
}) {
    useToastOnQueryError(isError, error, 'Unable to open Git diff');
    if (isError)
        return (
            <div className={gitMultiDiffErrorClassName}>
                {describeFailure(error, 'Unable to open Git diff')}
            </div>
        );
    if (!document) return <div className={gitMultiDiffPlaceholderClassName}>Loading diff…</div>;
    return (
        <DiffSurface
            key={`${document.format}:${!document.original}:${!document.modified}`}
            stacked
            contentHeight={contentHeight}
            document={document}
            repositoryId={repositoryId}
            sessionId={sessionId}
            source={source}
            onContentHeightChange={onContentHeightChange}
        />
    );
}

interface GitChangesDiffContentProperties {
    contentHeight?: number;
    onContentHeightChange?: (height: number) => void;
    path: string;
    repositoryId: string;
    sessionId: string;
}

function WorkingChangesDiffContent({
    contentHeight,
    onContentHeightChange,
    path,
    repositoryId,
    sessionId,
}: GitChangesDiffContentProperties) {
    const {
        data: document,
        isError,
        error,
    } = useCaxriQuery('git.diffDocument', {
        sessionId,
        repositoryId,
        path,
    });
    return (
        <GitChangesDiffResult
            contentHeight={contentHeight}
            document={document}
            error={error}
            isError={isError}
            repositoryId={repositoryId}
            sessionId={sessionId}
            source="working"
            onContentHeightChange={onContentHeightChange}
        />
    );
}

function PullRequestChangesDiffContent({
    contentHeight,
    onContentHeightChange,
    path,
    repositoryId,
    sessionId,
}: GitChangesDiffContentProperties) {
    const {
        data: document,
        isError,
        error,
    } = useCaxriQuery('git.pullRequestDiffDocument', {
        sessionId,
        repositoryId,
        path,
    });
    return (
        <GitChangesDiffResult
            contentHeight={contentHeight}
            document={document}
            error={error}
            isError={isError}
            repositoryId={repositoryId}
            sessionId={sessionId}
            source="pull-request"
            onContentHeightChange={onContentHeightChange}
        />
    );
}

function GitChangesDiffItem({
    file,
    repositoryId,
    repositoryRootPath,
    sessionId,
    source,
}: {
    file: GitFileStatus;
    repositoryId: string;
    repositoryRootPath?: string;
    sessionId: string;
    source: GitDiffTab['source'];
}) {
    const { active, containerRef } = useNearMultiDiffViewport();
    const [expanded, setExpanded] = useState(true);
    /**
     * Remembered across virtualization: when the item scrolls out of the near-viewport window the editor unmounts, and
     * the placeholder must keep the measured height — collapsing back to the initial height would shift the outer
     * scroll position under the user.
     */
    const [contentHeight, setContentHeight] = useState<number | undefined>(undefined);
    const label = file.originalPath ? `${file.originalPath} → ${file.path}` : file.path;
    const fileName = pathBasename(file.path);
    const Content =
        source === 'pull-request' ? PullRequestChangesDiffContent : WorkingChangesDiffContent;
    return (
        <section ref={containerRef} className="git-multi-diff-item border-b border-border">
            <div className="git-multi-diff-heading sticky top-0 z-10 flex h-9 items-center gap-1 border-b border-border bg-surface pr-2 pl-1.5">
                <button
                    type="button"
                    className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-left text-[11px] font-semibold text-foreground"
                    aria-expanded={expanded}
                    title={label}
                    onClick={() => setExpanded((value) => !value)}
                >
                    {expanded ? (
                        <ChevronDown className="shrink-0" size={13} />
                    ) : (
                        <ChevronRight className="shrink-0" size={13} />
                    )}
                    <FileTypeIcon entry={{ kind: 'file', name: fileName }} />
                    <span className="truncate">{label}</span>
                </button>
                {repositoryRootPath && file.kind !== 'deleted' && (
                    <Tooltip content="Open File">
                        <Button
                            className="git-multi-diff-open-file size-6"
                            size="icon"
                            variant="ghost"
                            aria-label={`Open ${file.path}`}
                            // openFile (not openEditorTab): it reads the file first and only creates
                            // the tab on success, so a missing path toasts instead of leaving a tab
                            // stuck on "Loading file…".
                            onClick={() => {
                                // eslint-disable-next-line no-void -- intentional floating-promise discard; openFile toasts internally
                                void openFile(`${repositoryRootPath}/${file.path}`);
                            }}
                        >
                            <FileSymlink size={13} />
                        </Button>
                    </Tooltip>
                )}
                <GitFileStatusLetter className="text-[11px]" file={file} />
            </div>
            {expanded &&
                (active ? (
                    <Content
                        contentHeight={contentHeight}
                        path={file.path}
                        repositoryId={repositoryId}
                        sessionId={sessionId}
                        onContentHeightChange={setContentHeight}
                    />
                ) : (
                    <div
                        className="git-multi-diff-placeholder"
                        style={{
                            height: Math.min(
                                contentHeight ?? initialStackedEditorHeight,
                                maxStackedEditorHeight,
                            ),
                        }}
                        aria-hidden="true"
                    />
                ))}
        </section>
    );
}

function ChangesDiffList({
    changedFileCount,
    emptyLabel,
    files,
    repositoryId,
    repositoryRootPath,
    sessionId,
    showExcluded,
    source,
    truncated = false,
}: {
    changedFileCount?: number;
    emptyLabel: string;
    files: readonly GitFileStatus[];
    repositoryId: string;
    repositoryRootPath?: string;
    sessionId: string;
    showExcluded: boolean;
    source: GitDiffTab['source'];
    truncated?: boolean;
}) {
    return (
        <GitChangesDiffList
            changedFileCount={changedFileCount}
            emptyLabel={emptyLabel}
            files={files}
            showExcluded={showExcluded}
            source={source}
            truncated={truncated}
            renderFile={(file) => (
                <GitChangesDiffItem
                    key={file.path}
                    file={file}
                    repositoryId={repositoryId}
                    repositoryRootPath={repositoryRootPath}
                    sessionId={sessionId}
                    source={source}
                />
            )}
        />
    );
}

function WorkingChangesDiffEditor({ tab }: { tab: Extract<GitDiffTab, { kind: 'changes' }> }) {
    const sessionId = useSelectedSession()?.id;
    const {
        data: summary,
        isError,
        error,
    } = useCaxriQuery(
        'git.summary',
        { sessionId: sessionId ?? '' },
        { enabled: Boolean(sessionId) },
    );
    useToastOnQueryError(isError, error, 'Unable to open Git changes');
    if (!sessionId) return null;
    if (isError)
        return (
            <div className={emptyWorkClassName}>
                {describeFailure(error, 'Unable to open Git changes')}
            </div>
        );
    if (!summary) return <div className={emptyWorkClassName}>Loading changes…</div>;
    const repo = summary.isRepository
        ? summary.repositories.find((candidate) => candidate.id === tab.repositoryId)
        : undefined;
    if (!repo)
        return <div className={emptyWorkClassName}>Git repository is no longer available</div>;
    return (
        <ChangesDiffList
            changedFileCount={repo.changedFileCount}
            emptyLabel="Working tree clean."
            files={repo.files}
            repositoryId={repo.id}
            repositoryRootPath={repo.rootPath}
            sessionId={sessionId}
            showExcluded={tab.showExcluded === true}
            source="working"
            truncated={repo.truncated}
        />
    );
}

function PullRequestChangesDiffEditor({ tab }: { tab: Extract<GitDiffTab, { kind: 'changes' }> }) {
    const sessionId = useSelectedSession()?.id;
    const {
        data: pullRequest,
        isError,
        error,
    } = useCaxriQuery(
        'git.pullRequestChanges',
        { sessionId: sessionId ?? '', repositoryId: tab.repositoryId, refresh: 0 },
        { enabled: Boolean(sessionId) },
    );
    // Resolves the repository root for the per-file "Open File" action; PR changes carry paths only.
    const { data: summary } = useCaxriQuery(
        'git.summary',
        { sessionId: sessionId ?? '' },
        { enabled: Boolean(sessionId) },
    );
    const repoRootPath = summary?.isRepository
        ? summary.repositories.find((candidate) => candidate.id === tab.repositoryId)?.rootPath
        : undefined;
    useToastOnQueryError(isError, error, 'Unable to open pull request changes');
    if (!sessionId) return null;
    if (isError)
        return (
            <div className={emptyWorkClassName}>
                {describeFailure(error, 'Unable to open pull request changes')}
            </div>
        );
    if (pullRequest === undefined)
        return <div className={emptyWorkClassName}>Loading pull request changes…</div>;
    if (pullRequest === null)
        return <div className={emptyWorkClassName}>No pull request for this branch.</div>;
    return (
        <ChangesDiffList
            emptyLabel="Pull request has no file changes."
            files={pullRequest.files}
            repositoryId={pullRequest.repositoryId}
            repositoryRootPath={repoRootPath}
            sessionId={sessionId}
            showExcluded={tab.showExcluded === true}
            source="pull-request"
        />
    );
}

export function GitDiffEditor({
    paneId,
    tab,
    tabPath,
}: {
    paneId: string;
    tab: GitDiffTab;
    tabPath: string;
}) {
    if (tab.kind === 'commit-file')
        return <CommitFileDiffEditor editorInstanceId={paneId} navigationKey={tabPath} tab={tab} />;
    if (tab.kind === 'file')
        return tab.source === 'pull-request' ? (
            <PullRequestFileDiffEditor
                editorInstanceId={paneId}
                navigationKey={tabPath}
                tab={tab}
            />
        ) : (
            <WorkingFileDiffEditor editorInstanceId={paneId} navigationKey={tabPath} tab={tab} />
        );
    return tab.source === 'pull-request' ? (
        <PullRequestChangesDiffEditor tab={tab} />
    ) : (
        <WorkingChangesDiffEditor tab={tab} />
    );
}
