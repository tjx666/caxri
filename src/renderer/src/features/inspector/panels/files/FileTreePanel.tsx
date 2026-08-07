import { ChevronDown, ChevronRight, Search, SquareMinus } from 'lucide-react';
import { useState } from 'react';

import type { FileEntry } from '@shared/types';

import { Button } from '../../../../components/ui/button';
import { CommandTooltip, Tooltip } from '../../../../components/ui/tooltip';
import { executeCommand } from '../../../../commands/execute';
import { FileTypeIcon } from '../../../../icons/files/FileTypeIcon';
import { cn } from '../../../../lib/utils';
import { useCaxriQuery, useToastOnQueryError } from '../../../../queries/client';
import { useSelectedProject, useSelectedSession } from '../../../../stores/selectors';
import { openFile } from '../../../editor/document-actions';
import { useFileTreeInvalidation } from './file-tree-refresh';
import { ProjectSearch } from './ProjectSearch';
import { closeFileSearch, useFileSearchStore } from './file-search-state';

interface EntryProps {
    sessionId: string;
    directory: string;
    depth?: number;
}

const treeRowClassName =
    'tree-row flex w-full h-7 items-center gap-2 pr-2 border-0 bg-surface text-left cursor-pointer hover:bg-elevated disabled:text-muted disabled:cursor-not-allowed';
const captionActionClassName =
    'pointer-events-none shrink-0 opacity-0 transition-opacity group-hover/file-caption:pointer-events-auto group-hover/file-caption:opacity-100 group-focus-within/file-caption:pointer-events-auto group-focus-within/file-caption:opacity-100';

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
    const sessionId = session?.id;
    const [collapseRevision, setCollapseRevision] = useState(0);
    const searchVisible = useFileSearchStore(
        (state) => Boolean(sessionId) && state.activeSessionId === sessionId,
    );
    const searchFocusRevision = useFileSearchStore((state) => state.focusRevision);
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
                    {project?.displayTitle ??
                        session.rootPath.split('/').filter(Boolean).at(-1) ??
                        ''}
                </span>
                <span className="flex items-center gap-0.5">
                    <CommandTooltip commandId="inspector.searchFiles">
                        <Button
                            className={cn(
                                searchVisible
                                    ? 'shrink-0 pointer-events-auto bg-elevated opacity-100 text-foreground'
                                    : captionActionClassName,
                            )}
                            size="icon"
                            variant="ghost"
                            aria-label="Search Files"
                            aria-pressed={searchVisible}
                            onClick={() => {
                                if (searchVisible) closeFileSearch(session.id);
                                else executeCommand('inspector.searchFiles');
                            }}
                        >
                            <Search size={13} />
                        </Button>
                    </CommandTooltip>
                    <Tooltip content="Collapse Folders">
                        <Button
                            className={captionActionClassName}
                            size="icon"
                            variant="ghost"
                            aria-label="Collapse Folders"
                            onClick={() => setCollapseRevision((value) => value + 1)}
                        >
                            <SquareMinus size={13} />
                        </Button>
                    </Tooltip>
                </span>
            </div>
            {searchVisible ? (
                <ProjectSearch focusRevision={searchFocusRevision} sessionId={session.id} />
            ) : (
                <div className="min-h-0 flex-1 overflow-auto">
                    <DirectoryEntries
                        key={`${session.id}:${collapseRevision}`}
                        sessionId={session.id}
                        directory={session.rootPath}
                    />
                </div>
            )}
        </div>
    );
}
