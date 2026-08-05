import Editor, { DiffEditor, type MonacoDiffEditor } from '@monaco-editor/react';
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { gitDiffModelPath, type GitDiffTab } from '@shared/git-diff';
import type { GitDiffDocument, GitFileStatus, GitRepositorySummary } from '@shared/types';

import { caxri } from '../../lib/caxri';
import { applyEditorTheme } from '../../lib/editor-theme';
import { useSelectedSession, useTheme } from '../../state/selectors';
import { describeFailure, pushToast } from '../../state/toasts';

function useGitRevision(sessionId: string | undefined): number {
    const [revision, setRevision] = useState(0);
    useEffect(
        () =>
            caxri.onEvent((event) => {
                if (event.event === 'files.changed' && event.payload.sessionId === sessionId)
                    setRevision((value) => value + 1);
            }),
        [sessionId],
    );
    return revision;
}

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
    const revision = useGitRevision(sessionId);
    const [document, setDocument] = useState<GitDiffDocument>();
    const [error, setError] = useState<string>();
    useEffect(() => {
        if (!sessionId) return;
        let canceled = false;
        void caxri
            .request('git.diffDocument', {
                sessionId,
                repositoryId: tab.repositoryId,
                path: tab.path,
            })
            .then((nextDocument) => {
                if (!canceled) {
                    setDocument(nextDocument);
                    setError(undefined);
                }
            })
            .catch((failure: unknown) => {
                if (canceled) return;
                const message = describeFailure(failure, 'Unable to open Git diff');
                setError(message);
                pushToast('error', message);
            });
        return () => {
            canceled = true;
        };
    }, [revision, sessionId, tab.path, tab.repositoryId]);
    if (!sessionId) return null;
    if (error) return <div className="empty-work">{error}</div>;
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
    const [document, setDocument] = useState<GitDiffDocument>();
    const [error, setError] = useState<string>();
    useEffect(() => {
        let canceled = false;
        void caxri
            .request('git.diffDocument', { sessionId, repositoryId, path })
            .then((nextDocument) => {
                if (!canceled) setDocument(nextDocument);
            })
            .catch((failure: unknown) => {
                if (!canceled) setError(describeFailure(failure, 'Unable to open Git diff'));
            });
        return () => {
            canceled = true;
        };
    }, [path, repositoryId, sessionId]);
    if (error) return <div className="git-multi-diff-error">{error}</div>;
    if (!document) return <div className="git-multi-diff-placeholder">Loading diff…</div>;
    return <DiffSurface document={document} repositoryId={repositoryId} sessionId={sessionId} />;
}

function GitChangesDiffItem({
    file,
    repositoryId,
    revision,
    sessionId,
}: {
    file: GitFileStatus;
    repositoryId: string;
    revision: number;
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
                        key={revision}
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
    const revision = useGitRevision(sessionId);
    const [repository, setRepository] = useState<GitRepositorySummary>();
    const [error, setError] = useState<string>();
    useEffect(() => {
        if (!sessionId) return;
        let canceled = false;
        void caxri
            .request('git.summary', { sessionId })
            .then((summary) => {
                const nextRepository = summary.repositories.find(
                    (candidate) => candidate.id === tab.repositoryId,
                );
                if (!nextRepository) throw new Error('Git repository is no longer available');
                return nextRepository;
            })
            .then((nextRepository) => {
                if (!canceled) {
                    setRepository(nextRepository);
                    setError(undefined);
                }
            })
            .catch((failure: unknown) => {
                if (canceled) return;
                const message = describeFailure(failure, 'Unable to open Git changes');
                setError(message);
                pushToast('error', message);
            });
        return () => {
            canceled = true;
        };
    }, [revision, sessionId, tab.repositoryId]);
    if (!sessionId) return null;
    if (error) return <div className="empty-work">{error}</div>;
    if (!repository) return <div className="empty-work">Loading changes…</div>;
    if (repository.files.length === 0) return <div className="empty-work">Working tree clean.</div>;
    return (
        <div className="git-multi-diff">
            {repository.files.map((file) => (
                <GitChangesDiffItem
                    key={file.path}
                    file={file}
                    repositoryId={repository.id}
                    revision={revision}
                    sessionId={sessionId}
                />
            ))}
        </div>
    );
}

export default function GitDiffEditor({ tab }: { tab: GitDiffTab }) {
    return tab.kind === 'file' ? <FileDiffEditor tab={tab} /> : <ChangesDiffEditor tab={tab} />;
}
