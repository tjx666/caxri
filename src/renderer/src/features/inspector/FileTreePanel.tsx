import { ChevronDown, ChevronRight, ListCollapse } from 'lucide-react';
import { useState } from 'react';

import type { FileEntry } from '@shared/types';

import { Button } from '../../components/ui/button';
import { FileTypeIcon } from '../../file-icons/FileTypeIcon';
import { useCaxriQuery, useToastOnQueryError } from '../../state/queries';
import { useSelectedSession } from '../../state/selectors';
import { openFile } from '../editor/document-actions';
import { useFileTreeInvalidation } from './file-tree-refresh';

interface EntryProps {
    sessionId: string;
    directory: string;
    depth?: number;
}

function DirectoryEntries({ sessionId, directory, depth = 0 }: EntryProps) {
    const {
        data: entries = [],
        isError,
        error,
    } = useCaxriQuery('files.list', {
        sessionId,
        directory,
    });
    useToastOnQueryError(isError, error, 'Unable to read directory');

    return (
        <div className="file-list">
            {entries.map((entry) => (
                <FileTreeItem key={entry.path} entry={entry} sessionId={sessionId} depth={depth} />
            ))}
        </div>
    );
}

function FileTreeItem({
    entry,
    sessionId,
    depth,
}: {
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
    const sessionId = session?.id;
    /**
     * Invalidates only the `files.list` queries a `files.changed` event actually touched — an
     * overflowed watcher batch invalidates every visible directory, otherwise only the parent
     * directory of each changed path does. This stays local rather than joining the central
     * `useRuntimeQueryInvalidation` pass because it needs the per-directory targeting.
     */
    useFileTreeInvalidation(sessionId);
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
                sessionId={session.id}
                directory={session.rootPath}
            />
        </div>
    );
}
