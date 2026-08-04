import {
    Bot,
    ChevronDown,
    ChevronRight,
    CircleAlert,
    Files,
    GitBranch,
    RefreshCw,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import type {
    AgentSnapshot,
    FileEntry,
    GitSummary,
    InspectorMode,
    SessionRecord,
    TerminalRecord,
} from '@shared/types';

import { AgentIdentityIcon } from '../agent-icons/AgentIdentityIcon';
import { resolveAgentIcon } from '../agent-icons/agent-icon-registry';
import { FileTypeIcon } from '../file-icons/FileTypeIcon';
import { Button } from './ui/button';

interface InspectorProps {
    session?: SessionRecord;
    terminals: TerminalRecord[];
    mode: InspectorMode;
    onModeChange: (mode: InspectorMode) => void;
    onOpenFile: (path: string) => void;
    onError: (message: string) => void;
}

function DirectoryEntries({
    sessionId,
    directory,
    depth = 0,
    revision,
    onOpenFile,
    onError,
}: {
    sessionId: string;
    directory?: string;
    depth?: number;
    revision: number;
    onOpenFile: (path: string) => void;
    onError: (message: string) => void;
}) {
    const [entries, setEntries] = useState<FileEntry[]>([]);
    useEffect(() => {
        let canceled = false;
        void window.caxri
            .request<FileEntry[]>('files.list', { sessionId, directory })
            .then((nextEntries) => {
                if (!canceled) setEntries(nextEntries);
            })
            .catch((error: unknown) => {
                if (!canceled)
                    onError(error instanceof Error ? error.message : 'Unable to read directory');
            });
        return () => {
            canceled = true;
        };
    }, [sessionId, directory, onError, revision]);

    return (
        <div className="file-list">
            {entries.map((entry) => (
                <FileTreeItem
                    key={entry.path}
                    entry={entry}
                    sessionId={sessionId}
                    depth={depth}
                    revision={revision}
                    onOpenFile={onOpenFile}
                    onError={onError}
                />
            ))}
        </div>
    );
}

function FileTreeItem({
    entry,
    sessionId,
    depth,
    revision,
    onOpenFile,
    onError,
}: {
    entry: FileEntry;
    sessionId: string;
    depth: number;
    revision: number;
    onOpenFile: (path: string) => void;
    onError: (message: string) => void;
}) {
    const [expanded, setExpanded] = useState(false);
    if (entry.kind === 'directory') {
        return (
            <div>
                <button
                    className="tree-row"
                    style={{ paddingLeft: 8 + depth * 12 }}
                    onClick={() => setExpanded((value) => !value)}
                >
                    {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    <FileTypeIcon entry={entry} expanded={expanded} />
                    <span>{entry.name}</span>
                </button>
                {expanded && (
                    <DirectoryEntries
                        sessionId={sessionId}
                        directory={entry.path}
                        depth={depth + 1}
                        revision={revision}
                        onOpenFile={onOpenFile}
                        onError={onError}
                    />
                )}
            </div>
        );
    }
    return (
        <button
            className="tree-row"
            style={{ paddingLeft: 23 + depth * 12 }}
            disabled={entry.kind === 'symlink'}
            title={
                entry.kind === 'symlink' ? 'Symlink browsing is disabled for safety' : entry.path
            }
            onClick={() => onOpenFile(entry.path)}
        >
            <FileTypeIcon entry={entry} />
            <span>{entry.name}</span>
        </button>
    );
}

function FilesPanel({
    session,
    onOpenFile,
    onError,
}: Pick<InspectorProps, 'session' | 'onOpenFile' | 'onError'>) {
    const [revision, setRevision] = useState(0);
    const sessionId = session?.id;
    useEffect(
        () =>
            window.caxri.onEvent((event) => {
                if (event.event === 'files.changed' && event.payload.sessionId === sessionId)
                    setRevision((value) => value + 1);
            }),
        [sessionId],
    );
    if (!session) return <div className="empty-panel">Create a Session to browse files.</div>;
    return (
        <div key={session.id} className="inspector-content">
            <div className="panel-caption" title={session.rootPath}>
                {session.rootPath}
            </div>
            <DirectoryEntries
                sessionId={session.id}
                revision={revision}
                onOpenFile={onOpenFile}
                onError={onError}
            />
        </div>
    );
}

function GitPanel({ session, onError }: Pick<InspectorProps, 'session' | 'onError'>) {
    const [summary, setSummary] = useState<GitSummary>();
    const [selectedRepositoryId, setSelectedRepositoryId] = useState<string>();
    const [selected, setSelected] = useState<string>();
    const [diff, setDiff] = useState('');
    const [revision, setRevision] = useState(0);
    const sessionId = session?.id;
    const refresh = useCallback((): void => {
        if (!sessionId) return;
        void window.caxri
            .request<GitSummary>('git.summary', { sessionId })
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
                onError(error instanceof Error ? error.message : 'Git refresh failed'),
            );
    }, [onError, sessionId]);
    useEffect(() => {
        refresh();
    }, [refresh]);
    useEffect(() => {
        let refreshTimer: number | undefined;
        const unsubscribe = window.caxri.onEvent((event) => {
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
        void window.caxri
            .request<string>('git.diff', {
                sessionId,
                repositoryId: selectedRepositoryId,
                path: selected,
            })
            .then(setDiff)
            .catch((error: unknown) =>
                onError(error instanceof Error ? error.message : 'Git diff failed'),
            );
    }, [onError, revision, selected, selectedRepositoryId, sessionId]);
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

function AgentPanel({ session, onError }: Pick<InspectorProps, 'session' | 'onError'>) {
    const sessionId = session?.id;
    const [snapshots, setSnapshots] = useState<AgentSnapshot[]>([]);
    useEffect(() => {
        if (!sessionId) return;
        void Promise.all(
            (['claude', 'codex'] as const).map((provider) =>
                window.caxri.request<AgentSnapshot>('agent.snapshot', { sessionId, provider }),
            ),
        )
            .then(setSnapshots)
            .catch((error: unknown) =>
                onError(error instanceof Error ? error.message : 'Agent discovery failed'),
            );
    }, [onError, sessionId]);
    if (!session) return <div className="empty-panel">Create a Session to inspect agents.</div>;
    return (
        <div className="inspector-content agent-panel">
            {snapshots.map((snapshot) => (
                <section key={snapshot.provider} className="agent-card">
                    <div className="agent-title">
                        <AgentIdentityIcon identity={snapshot.provider} size={15} />{' '}
                        {resolveAgentIcon(snapshot.provider).label}
                    </div>
                    <dl>
                        <dt>Availability</dt>
                        <dd>{snapshot.available ? 'Installed' : 'Not found'}</dd>
                        <dt>Activity</dt>
                        <dd className="unknown">
                            <CircleAlert size={12} /> {snapshot.status}
                        </dd>
                        {snapshot.version && (
                            <>
                                <dt>Version</dt>
                                <dd>{snapshot.version}</dd>
                            </>
                        )}
                        {snapshot.title && (
                            <>
                                <dt>Session title</dt>
                                <dd>{snapshot.title}</dd>
                            </>
                        )}
                        {snapshot.sessionId && (
                            <>
                                <dt>Session ID</dt>
                                <dd>{snapshot.sessionId}</dd>
                            </>
                        )}
                        {snapshot.usage?.map((item) => (
                            <div key={item.label} className="agent-metadata-row">
                                <dt>{item.label}</dt>
                                <dd>{item.value}</dd>
                            </div>
                        ))}
                    </dl>
                    <p>
                        Local metadata is read-only. Unknown means no reliable signal was found;
                        Terminal I/O remains available.
                    </p>
                </section>
            ))}
        </div>
    );
}

export function Inspector(props: InspectorProps) {
    const tabs: Array<{ id: InspectorMode; label: string; icon: typeof Files }> = [
        { id: 'files', label: 'Files', icon: Files },
        { id: 'git', label: 'Git', icon: GitBranch },
        { id: 'agent', label: 'Agent', icon: Bot },
    ];
    return (
        <aside className="inspector">
            <div className="inspector-tabs">
                {tabs.map(({ id, label, icon: Icon }) => (
                    <button
                        key={id}
                        className={props.mode === id ? 'active' : ''}
                        title={label}
                        onClick={() => props.onModeChange(id)}
                    >
                        <Icon size={15} />
                        <span>{label}</span>
                    </button>
                ))}
            </div>
            {props.mode === 'files' && <FilesPanel {...props} />}
            {props.mode === 'git' && <GitPanel key={props.session?.id} {...props} />}
            {props.mode === 'agent' && <AgentPanel {...props} />}
        </aside>
    );
}
