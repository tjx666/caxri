import { GitBranch, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import type { GitSummary } from '@shared/types';

import { Button } from '../../components/ui/button';
import { caxri } from '../../lib/caxri';
import { useSelectedSession } from '../../state/selectors';
import { describeFailure, pushToast } from '../../state/toasts';

/**
 * Mounted with `key={session.id}` by the Inspector shell, so repository and diff selection reset
 * whenever the selected Session changes instead of leaking across Project roots.
 */
export function GitPanel() {
    const session = useSelectedSession();
    const [summary, setSummary] = useState<GitSummary>();
    const [selectedRepositoryId, setSelectedRepositoryId] = useState<string>();
    const [selected, setSelected] = useState<string>();
    const [diff, setDiff] = useState('');
    const [revision, setRevision] = useState(0);
    const sessionId = session?.id;
    const refresh = useCallback((): void => {
        if (!sessionId) return;
        void caxri
            .request('git.summary', { sessionId })
            .then((nextSummary) => {
                setSummary(nextSummary);
                setSelectedRepositoryId((current) =>
                    nextSummary.repositories.some((repository) => repository.id === current)
                        ? current
                        : nextSummary.repositories[0]?.id,
                );
                setRevision((value) => value + 1);
            })
            .catch((error: unknown) =>
                pushToast('error', describeFailure(error, 'Git refresh failed')),
            );
    }, [sessionId]);
    useEffect(() => {
        refresh();
    }, [refresh]);
    useEffect(() => {
        let refreshTimer: number | undefined;
        const unsubscribe = caxri.onEvent((event) => {
            if (event.event !== 'files.changed' || event.payload.sessionId !== sessionId) return;
            if (refreshTimer) window.clearTimeout(refreshTimer);
            refreshTimer = window.setTimeout(refresh, 150);
        });
        return () => {
            unsubscribe();
            if (refreshTimer) window.clearTimeout(refreshTimer);
        };
    }, [refresh, sessionId]);
    useEffect(() => {
        if (!sessionId || !selectedRepositoryId || !selected) return;
        void caxri
            .request('git.diff', {
                sessionId,
                repositoryId: selectedRepositoryId,
                path: selected,
            })
            .then(setDiff)
            .catch((error: unknown) =>
                pushToast('error', describeFailure(error, 'Git diff failed')),
            );
    }, [revision, selected, selectedRepositoryId, sessionId]);
    if (!session) return <div className="empty-panel">Create a Session to inspect Git.</div>;
    if (!summary) return <div className="empty-panel">Loading Git status…</div>;
    if (!summary.isRepository) return <div className="empty-panel">{summary.error}</div>;
    const selectedRepository =
        summary.repositories.find((repository) => repository.id === selectedRepositoryId) ??
        summary.repositories[0];
    if (!selectedRepository)
        return <div className="empty-panel">No approved Git repositories found.</div>;
    return (
        <div className="inspector-content git-panel">
            {summary.repositories.length > 1 && (
                <div className="git-repositories" aria-label="Git repositories">
                    {summary.repositories.map((repository) => (
                        <button
                            key={repository.id}
                            className={
                                repository.id === selectedRepository.id
                                    ? 'git-repository-row active'
                                    : 'git-repository-row'
                            }
                            onClick={() => {
                                setSelectedRepositoryId(repository.id);
                                setSelected(undefined);
                                setDiff('');
                            }}
                        >
                            <span>
                                <GitBranch size={12} />
                                <strong>{repository.name}</strong>
                                <small>{repository.kind}</small>
                            </span>
                            <span title={`${repository.ahead} ahead, ${repository.behind} behind`}>
                                {repository.branch} · ↑{repository.ahead} ↓{repository.behind} ·{' '}
                                {repository.files.length}
                            </span>
                        </button>
                    ))}
                </div>
            )}
            <div className="git-heading">
                <span>
                    <GitBranch size={13} /> {selectedRepository.branch}{' '}
                    <code>{selectedRepository.head}</code>
                </span>
                <Button size="icon" variant="ghost" aria-label="Refresh Git" onClick={refresh}>
                    <RefreshCw size={13} />
                </Button>
            </div>
            <div className="git-files">
                {selectedRepository.files.length === 0 && (
                    <div className="empty-panel">Working tree clean.</div>
                )}
                {selectedRepository.files.map((file) => (
                    <button
                        key={file.path}
                        className={selected === file.path ? 'git-row active' : 'git-row'}
                        onClick={() => setSelected(file.path)}
                    >
                        <span className={`status status-${file.kind}`}>
                            {file.index === ' ' ? file.workingTree : file.index}
                        </span>
                        <span title={file.path}>{file.path}</span>
                    </button>
                ))}
            </div>
            {selected && (
                <pre className="diff-view">{diff || 'No unstaged diff for this file.'}</pre>
            )}
        </div>
    );
}
