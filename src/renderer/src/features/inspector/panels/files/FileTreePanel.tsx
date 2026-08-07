import { ChevronDown, ChevronRight, SquareMinus } from 'lucide-react';
import { useState } from 'react';

import type { FileEntry } from '@shared/types';

import { Button } from '../../../../components/ui/button';
import { FileTypeIcon } from '../../../../icons/files/FileTypeIcon';
import { useCaxriQuery, useToastOnQueryError } from '../../../../queries/client';
import { useSelectedProject, useSelectedSession } from '../../../../stores/selectors';
import { openFile } from '../../../editor/document-actions';
import { useFileTreeInvalidation } from './file-tree-refresh';
import { ProjectSearch } from './ProjectSearch';

interface EntryProps {
    sessionId: string;
    directory: string;
    depth?: number;
}

const treeRowClassName =
    'tree-row flex w-full h-7 items-center gap-2 pr-2 border-0 bg-surface text-left cursor-pointer hover:bg-elevated disabled:text-muted disabled:cursor-not-allowed';

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
                    className={treeRowClassName}
                    style={{ paddingLeft: 8 + depth * 12 }}
                    onClick={() => setExpanded((value) => !value)}
                >
                    {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    <FileTypeIcon entry={entry} expanded={expanded} />
                    <span className="truncate">{entry.name}</span>
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
            className={treeRowClassName}
            style={{ paddingLeft: 23 + depth * 12 }}
            disabled={entry.kind === 'symlink'}
            title={
                entry.kind === 'symlink' ? 'Symlink browsing is disabled for safety' : entry.path
            }
            onClick={() => void openFile(entry.path, { preview: true })}
            onDoubleClick={() => void openFile(entry.path)}
        >
            <FileTypeIcon entry={entry} />
            <span className="truncate">{entry.name}</span>
        </button>
    );
}

export function FileTreePanel() {
    const session = useSelectedSession();
    const project = useSelectedProject();
    const [collapseRevision, setCollapseRevision] = useState(0);
    const sessionId = session?.id;
    /**
     * Invalidates only the `files.list` queries a `files.changed` event actually touched — an
     * overflowed watcher batch invalidates every visible directory, otherwise only the parent
     * directory of each changed path does. This stays local rather than joining the central
     * `useRuntimeQueryInvalidation` pass because it needs the per-directory targeting.
     */
    useFileTreeInvalidation(sessionId);
    if (!session)
        return (
            <div className="empty-panel py-4 px-3 text-muted text-center">
                Create a Session to browse files.
            </div>
        );
    /** Keyed by Session so expansion state from another Project root is never reused. */
    return (
        <div
            key={session.id}
            className="inspector-content flex min-h-0 flex-1 flex-col overflow-hidden"
        >
            <div className="panel-caption group/file-caption flex min-h-[34px] items-center justify-between gap-1 pt-[3px] pr-1 pb-[3px] pl-2 border-b border-border text-muted text-[11px]">
                <span className="truncate" title={session.rootPath}>
                    {(
                        project?.displayTitle ??
                        session.rootPath.split('/').filter(Boolean).at(-1) ??
                        ''
                    ).toLocaleUpperCase()}
                </span>
                <Button
                    className="pointer-events-none shrink-0 opacity-0 transition-opacity group-hover/file-caption:pointer-events-auto group-hover/file-caption:opacity-100 group-focus-within/file-caption:pointer-events-auto group-focus-within/file-caption:opacity-100"
                    size="icon"
                    variant="ghost"
                    aria-label="Collapse Folders"
                    title="Collapse Folders"
                    onClick={() => setCollapseRevision((value) => value + 1)}
                >
                    <SquareMinus size={13} />
                </Button>
            </div>
            <ProjectSearch sessionId={session.id}>
                <DirectoryEntries
                    key={`${session.id}:${collapseRevision}`}
                    sessionId={session.id}
                    directory={session.rootPath}
                />
            </ProjectSearch>
        </div>
    );
}
