import type { RefObject } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { MonacoDiffEditor } from '@monaco-editor/react';
import Editor, { DiffEditor } from '@monaco-editor/react';
import type { GitDiffTab } from '@shared/git-diff';
import { gitDiffModelPath } from '@shared/git-diff';
import type { GitDiffDocument, GitFileStatus } from '@shared/types';

import { applyEditorTheme } from '../../lib/editor-theme';
import { monaco } from '../../lib/monaco';
import { useCaxriQuery, useToastOnQueryError } from '../../queries/client';
import { useSelectedSession, useTheme } from '../../stores/selectors';
import { describeFailure } from '../../stores/toasts';
import { resolveRegisteredEditorLanguage } from './editor-language';

const emptyWorkClassName =
    'empty-work flex h-full flex-col items-center justify-center gap-3 text-muted';
const gitMultiDiffPlaceholderClassName =
    'git-multi-diff-placeholder grid h-full place-items-center text-muted text-[11px]';
const gitMultiDiffErrorClassName =
    'git-multi-diff-error grid h-full place-items-center text-danger text-[11px]';

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
        const observer = new IntersectionObserver(([entry]) => setActive(entry?.isIntersecting), {
            root: element.closest('.git-multi-diff'),
            rootMargin: '720px 0px',
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, []);
    return { active, containerRef: containerReference };
}

function DiffSurface({
    document,
    repositoryId,
    sessionId,
    source,
}: {
    document: GitDiffDocument;
    repositoryId: string;
    sessionId: string;
    source: GitDiffTab['source'];
}) {
    const theme = useTheme();
    const editorReference = useRef<MonacoDiffEditor | null>(null);
    useEffect(() => {
        if (theme) applyEditorTheme(theme);
    }, [theme]);
    useLayoutEffect(
        () => () => {
            /**
             * Detach both models before the wrapper disposes them. Monaco otherwise observes a disposed model from a
             * still-mounted diff widget when many editors unmount together.
             */
            editorReference.current?.setModel(null);
            editorReference.current = null;
        },
        [],
    );
    if (!theme) return null;
    const modelRepoId = `${source}:${repositoryId}`;
    const registrations = monaco.languages.getLanguages();
    const originalLanguage = resolveRegisteredEditorLanguage(
        document.originalPath ?? document.path,
        registrations,
    );
    const modifiedLanguage = resolveRegisteredEditorLanguage(document.path, registrations);
    if (document.format === 'patch')
        return (
            <Editor
                className="git-patch-editor h-full w-full"
                language="diff"
                path={`${gitDiffModelPath(sessionId, modelRepoId, document.path, 'modified')}.diff`}
                value={document.modified}
                theme="caxri-active"
                beforeMount={() => applyEditorTheme(theme)}
                options={{
                    automaticLayout: true,
                    fontSize: 13,
                    minimap: { enabled: false },
                    readOnly: true,
                    scrollBeyondLastLine: false,
                    wordWrap: 'off',
                }}
            />
        );
    return (
        <DiffEditor
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
            onMount={(editor) => {
                editorReference.current = editor;
            }}
            options={{
                automaticLayout: true,
                fontSize: 13,
                minimap: { enabled: false },
                originalEditable: false,
                readOnly: true,
                renderSideBySide: true,
                scrollBeyondLastLine: false,
                wordWrap: 'off',
            }}
        />
    );
}

function FileDiffResult({
    document,
    error,
    isError,
    sessionId,
    tab,
}: {
    document?: GitDiffDocument;
    error: Error | null;
    isError: boolean;
    sessionId?: string;
    tab: Extract<GitDiffTab, { kind: 'file' }>;
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
                document={document}
                repositoryId={tab.repositoryId}
                sessionId={sessionId}
                source={tab.source}
            />
        </div>
    );
}

function WorkingFileDiffEditor({ tab }: { tab: Extract<GitDiffTab, { kind: 'file' }> }) {
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
            error={error}
            isError={isError}
            sessionId={sessionId}
            tab={tab}
        />
    );
}

function PullRequestFileDiffEditor({ tab }: { tab: Extract<GitDiffTab, { kind: 'file' }> }) {
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
            error={error}
            isError={isError}
            sessionId={sessionId}
            tab={tab}
        />
    );
}

function GitChangesDiffResult({
    document,
    error,
    isError,
    repositoryId,
    sessionId,
    source,
}: {
    document?: GitDiffDocument;
    error: Error | null;
    isError: boolean;
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
            document={document}
            repositoryId={repositoryId}
            sessionId={sessionId}
            source={source}
        />
    );
}

interface GitChangesDiffContentProperties {
    path: string;
    repositoryId: string;
    sessionId: string;
}

function WorkingChangesDiffContent({
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
            document={document}
            error={error}
            isError={isError}
            repositoryId={repositoryId}
            sessionId={sessionId}
            source="working"
        />
    );
}

function PullRequestChangesDiffContent({
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
            document={document}
            error={error}
            isError={isError}
            repositoryId={repositoryId}
            sessionId={sessionId}
            source="pull-request"
        />
    );
}

function GitChangesDiffItem({
    file,
    repositoryId,
    sessionId,
    source,
}: {
    file: GitFileStatus;
    repositoryId: string;
    sessionId: string;
    source: GitDiffTab['source'];
}) {
    const { active, containerRef } = useNearMultiDiffViewport();
    const label = file.originalPath ? `${file.originalPath} → ${file.path}` : file.path;
    const Content =
        source === 'pull-request' ? PullRequestChangesDiffContent : WorkingChangesDiffContent;
    return (
        <section ref={containerRef} className="git-multi-diff-item border-b border-border">
            <div
                className="git-multi-diff-heading h-9 overflow-hidden border-b border-border bg-surface px-3 text-[11px] leading-9 font-semibold text-ellipsis whitespace-nowrap text-foreground"
                title={label}
            >
                {label}
            </div>
            <div className="git-multi-diff-editor h-[360px]">
                {!active && <div className={gitMultiDiffPlaceholderClassName} aria-hidden="true" />}
                {active && (
                    <Content path={file.path} repositoryId={repositoryId} sessionId={sessionId} />
                )}
            </div>
        </section>
    );
}

function ChangesDiffList({
    emptyLabel,
    files,
    repositoryId,
    sessionId,
    source,
}: {
    emptyLabel: string;
    files: GitFileStatus[];
    repositoryId: string;
    sessionId: string;
    source: GitDiffTab['source'];
}) {
    if (files.length === 0) return <div className={emptyWorkClassName}>{emptyLabel}</div>;
    return (
        <div className="git-multi-diff absolute inset-0 overflow-auto bg-background">
            {files.map((file) => (
                <GitChangesDiffItem
                    key={file.path}
                    file={file}
                    repositoryId={repositoryId}
                    sessionId={sessionId}
                    source={source}
                />
            ))}
        </div>
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
            emptyLabel="Working tree clean."
            files={repo.files}
            repositoryId={repo.id}
            sessionId={sessionId}
            source="working"
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
            sessionId={sessionId}
            source="pull-request"
        />
    );
}

export function GitDiffEditor({ tab }: { tab: GitDiffTab }) {
    if (tab.kind === 'file')
        return tab.source === 'pull-request' ? (
            <PullRequestFileDiffEditor tab={tab} />
        ) : (
            <WorkingFileDiffEditor tab={tab} />
        );
    return tab.source === 'pull-request' ? (
        <PullRequestChangesDiffEditor tab={tab} />
    ) : (
        <WorkingChangesDiffEditor tab={tab} />
    );
}
