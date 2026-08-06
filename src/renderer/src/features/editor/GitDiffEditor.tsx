import Editor, { DiffEditor, type MonacoDiffEditor } from '@monaco-editor/react';
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { gitDiffModelPath, type GitDiffTab } from '@shared/git-diff';
import type { GitDiffDocument, GitFileStatus } from '@shared/types';

import { applyEditorTheme } from '../../lib/editor-theme';
import { useCaxriQuery, useToastOnQueryError } from '../../state/queries';
import { useSelectedSession, useTheme } from '../../state/selectors';
import { describeFailure } from '../../state/toasts';

function useNearMultiDiffViewport(): {
    active: boolean;
    containerRef: RefObject<HTMLElement | null>;
} {
    const containerRef = useRef<HTMLElement | null>(null);
    const [active, setActive] = useState(false);
    useEffect(() => {
        const element = containerRef.current;
        if (!element || typeof IntersectionObserver === 'undefined') {
            setActive(true);
            return;
        }
        const observer = new IntersectionObserver(
            ([entry]) => setActive(Boolean(entry?.isIntersecting)),
            {
                root: element.closest('.git-multi-diff'),
                rootMargin: '720px 0px',
            },
        );
        observer.observe(element);
        return () => observer.disconnect();
    }, []);
    return { active, containerRef };
}

function DiffSurface({
    document,
    repositoryId,
    sessionId,
}: {
    document: GitDiffDocument;
    repositoryId: string;
    sessionId: string;
}) {
    const theme = useTheme();
    const editorRef = useRef<MonacoDiffEditor | null>(null);
    useEffect(() => {
        if (theme) applyEditorTheme(theme);
    }, [theme]);
    useLayoutEffect(
        () => () => {
            /**
             * Detach both models before the wrapper disposes them. Monaco otherwise observes a
             * disposed model from a still-mounted diff widget when many editors unmount together.
             */
            editorRef.current?.setModel(null);
            editorRef.current = null;
        },
        [],
    );
    if (!theme) return null;
    if (document.format === 'patch')
        return (
            <Editor
                className="git-patch-editor"
                language="diff"
                path={`${gitDiffModelPath(sessionId, repositoryId, document.path, 'modified')}.diff`}
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
            originalModelPath={gitDiffModelPath(
                sessionId,
                repositoryId,
                document.originalPath ?? document.path,
                'original',
            )}
            modifiedModelPath={gitDiffModelPath(sessionId, repositoryId, document.path, 'modified')}
            theme="caxri-active"
            beforeMount={() => applyEditorTheme(theme)}
            onMount={(editor) => {
                editorRef.current = editor;
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

function FileDiffEditor({ tab }: { tab: Extract<GitDiffTab, { kind: 'file' }> }) {
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
    useToastOnQueryError(isError, error, 'Unable to open Git diff');
    if (!sessionId) return null;
    if (isError)
        return (
            <div className="empty-work">{describeFailure(error, 'Unable to open Git diff')}</div>
        );
    if (!document) return <div className="empty-work">Loading diff…</div>;
    return (
        <div className="git-file-diff">
            <DiffSurface
                document={document}
                repositoryId={tab.repositoryId}
                sessionId={sessionId}
            />
        </div>
    );
}

function GitChangesDiffContent({
    path,
    repositoryId,
    sessionId,
}: {
    path: string;
    repositoryId: string;
    sessionId: string;
}) {
    const {
        data: document,
        isError,
        error,
    } = useCaxriQuery('git.diffDocument', {
        sessionId,
        repositoryId,
        path,
    });
    useToastOnQueryError(isError, error, 'Unable to open Git diff');
    if (isError)
        return (
            <div className="git-multi-diff-error">
                {describeFailure(error, 'Unable to open Git diff')}
            </div>
        );
    if (!document) return <div className="git-multi-diff-placeholder">Loading diff…</div>;
    return <DiffSurface document={document} repositoryId={repositoryId} sessionId={sessionId} />;
}

function GitChangesDiffItem({
    file,
    repositoryId,
    sessionId,
}: {
    file: GitFileStatus;
    repositoryId: string;
    sessionId: string;
}) {
    const { active, containerRef } = useNearMultiDiffViewport();
    const label = file.originalPath ? `${file.originalPath} → ${file.path}` : file.path;
    return (
        <section ref={containerRef} className="git-multi-diff-item">
            <div className="git-multi-diff-heading" title={label}>
                {label}
            </div>
            <div className="git-multi-diff-editor">
                {!active && <div className="git-multi-diff-placeholder" aria-hidden="true" />}
                {active && (
                    <GitChangesDiffContent
                        path={file.path}
                        repositoryId={repositoryId}
                        sessionId={sessionId}
                    />
                )}
            </div>
        </section>
    );
}

function ChangesDiffEditor({ tab }: { tab: Extract<GitDiffTab, { kind: 'changes' }> }) {
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
            <div className="empty-work">{describeFailure(error, 'Unable to open Git changes')}</div>
        );
    if (!summary) return <div className="empty-work">Loading changes…</div>;
    const repository = summary.isRepository
        ? summary.repositories.find((candidate) => candidate.id === tab.repositoryId)
        : undefined;
    if (!repository) return <div className="empty-work">Git repository is no longer available</div>;
    if (repository.files.length === 0) return <div className="empty-work">Working tree clean.</div>;
    return (
        <div className="git-multi-diff">
            {repository.files.map((file) => (
                <GitChangesDiffItem
                    key={file.path}
                    file={file}
                    repositoryId={repository.id}
                    sessionId={sessionId}
                />
            ))}
        </div>
    );
}

export default function GitDiffEditor({ tab }: { tab: GitDiffTab }) {
    return tab.kind === 'file' ? <FileDiffEditor tab={tab} /> : <ChangesDiffEditor tab={tab} />;
}
