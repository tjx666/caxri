import { ChevronDown, ChevronRight, ListCollapse } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { FileEntry } from '@shared/types';

import { Button } from '../../components/ui/button';
import { FileTypeIcon } from '../../file-icons/FileTypeIcon';
import { caxri } from '../../lib/caxri';
import { useSelectedSession } from '../../state/selectors';
import { describeFailure, pushToast } from '../../state/toasts';
import { openFile } from '../editor/document-actions';
import { updateFileTreeChangeRevisions, type FileTreeChangeRevisions } from './file-tree-refresh';

interface EntryProps {
    changeRevisions: FileTreeChangeRevisions;
    sessionId: string;
    directory: string;
    depth?: number;
}

function DirectoryEntries({ changeRevisions, sessionId, directory, depth = 0 }: EntryProps) {
    const [entries, setEntries] = useState<FileEntry[]>([]);
    const refreshRevision =
        changeRevisions.sessionId === sessionId
            ? changeRevisions.overflow + (changeRevisions.directories[directory] ?? 0)
            : 0;
    useEffect(() => {
        let canceled = false;
        void caxri
            .request('files.list', { sessionId, directory })
            .then((nextEntries) => {
                if (!canceled) setEntries(nextEntries);
            })
            .catch((error: unknown) => {
                if (!canceled)
                    pushToast('error', describeFailure(error, 'Unable to read directory'));
            });
        return () => {
            canceled = true;
        };
    }, [sessionId, directory, refreshRevision]);

    return (
        <div className="file-list">
            {entries.map((entry) => (
                <FileTreeItem
                    key={entry.path}
                    changeRevisions={changeRevisions}
                    entry={entry}
                    sessionId={sessionId}
                    depth={depth}
                />
            ))}
        </div>
    );
}

function FileTreeItem({
    changeRevisions,
    entry,
    sessionId,
    depth,
}: {
    changeRevisions: FileTreeChangeRevisions;
    entry: FileEntry;
    sessionId: string;
    depth: number;
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
                        changeRevisions={changeRevisions}
                        sessionId={sessionId}
                        directory={entry.path}
                        depth={depth + 1}
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
            onClick={() => void openFile(entry.path)}
        >
            <FileTypeIcon entry={entry} />
            <span>{entry.name}</span>
        </button>
    );
}

export function FileTreePanel() {
    const session = useSelectedSession();
    const [collapseRevision, setCollapseRevision] = useState(0);
    const [changeRevisions, setChangeRevisions] = useState<FileTreeChangeRevisions>({
        directories: {},
        overflow: 0,
    });
    const sessionId = session?.id;
    useEffect(
        () =>
            caxri.onEvent((event) => {
                if (event.event !== 'files.changed' || event.payload.sessionId !== sessionId)
                    return;
                setChangeRevisions((previous) =>
                    updateFileTreeChangeRevisions(previous, event.payload),
                );
            }),
        [sessionId],
    );
    if (!session) return <div className="empty-panel">Create a Session to browse files.</div>;
    /** Keyed by Session so expansion state from another Project root is never reused. */
    return (
        <div key={session.id} className="inspector-content">
            <div className="panel-caption">
                <span title={session.rootPath}>{session.rootPath}</span>
                <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Collapse Folders"
                    title="Collapse Folders"
                    onClick={() => setCollapseRevision((value) => value + 1)}
                >
                    <ListCollapse size={13} />
                </Button>
            </div>
            <DirectoryEntries
                key={`${session.id}:${collapseRevision}`}
                changeRevisions={changeRevisions}
                sessionId={session.id}
                directory={session.rootPath}
            />
        </div>
    );
}
