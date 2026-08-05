import { ChevronDown, ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { FileEntry } from '@shared/types';

import { FileTypeIcon } from '../../file-icons/FileTypeIcon';
import { caxri } from '../../lib/caxri';
import { useSelectedSession } from '../../state/selectors';
import { describeFailure, pushToast } from '../../state/toasts';
import { openFile } from '../editor/document-actions';

interface EntryProps {
    sessionId: string;
    directory?: string;
    depth?: number;
    revision: number;
}

function DirectoryEntries({ sessionId, directory, depth = 0, revision }: EntryProps) {
    const [entries, setEntries] = useState<FileEntry[]>([]);
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
    }, [sessionId, directory, revision]);

    return (
        <div className="file-list">
            {entries.map((entry) => (
                <FileTreeItem
                    key={entry.path}
                    entry={entry}
                    sessionId={sessionId}
                    depth={depth}
                    revision={revision}
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
}: {
    entry: FileEntry;
    sessionId: string;
    depth: number;
    revision: number;
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
    const [revision, setRevision] = useState(0);
    const sessionId = session?.id;
    useEffect(
        () =>
            caxri.onEvent((event) => {
                if (event.event === 'files.changed' && event.payload.sessionId === sessionId)
                    setRevision((value) => value + 1);
            }),
        [sessionId],
    );
    if (!session) return <div className="empty-panel">Create a Session to browse files.</div>;
    /** Keyed by Session so expansion state from another Project root is never reused. */
    return (
        <div key={session.id} className="inspector-content">
            <div className="panel-caption" title={session.rootPath}>
                {session.rootPath}
            </div>
            <DirectoryEntries sessionId={session.id} revision={revision} />
        </div>
    );
}
