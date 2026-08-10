import { ChevronDown, ChevronRight, FilePlus, Search, SquareMinus } from 'lucide-react';
import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';

import type { FileEntry } from '@shared/types';

import { Button } from '../../../../components/ui/button';
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
} from '../../../../components/ui/context-menu';
import { CommandTooltip, Tooltip } from '../../../../components/ui/tooltip';
import { executeCommand } from '../../../../commands/execute';
import { FileTypeIcon } from '../../../../icons/files/FileTypeIcon';
import { cn } from '../../../../lib/utils';
import { useCaxriQuery, useToastOnQueryError } from '../../../../queries/client';
import { useSelectedProject, useSelectedSession } from '../../../../stores/selectors';
import { describeFailure } from '../../../../stores/toasts';
import { openFile } from '../../../editor/document-actions';
import { createFile, moveFile, renameFile, trashFile } from './file-actions';
import { useFileTreeInvalidation } from './file-tree-refresh';
import { ProjectSearch } from './ProjectSearch';
import { closeFileSearch, useFileSearchStore } from './file-search-state';

const FILE_TREE_DRAG_TYPE = 'application/x-caxri-file-path';

type EditRequest = { kind: 'create'; directory: string } | { kind: 'rename'; entry: FileEntry };

interface TreeProps {
    depth?: number;
    directory: string;
    editing?: EditRequest;
    selectedPath?: string;
    sessionId: string;
    setEditing: (editing?: EditRequest) => void;
    setSelectedPath: (path?: string) => void;
}

const treeRowClassName =
    'tree-row flex w-full h-7 items-center gap-2 pr-2 border-0 bg-surface text-left cursor-pointer hover:bg-elevated disabled:text-muted disabled:cursor-not-allowed data-[selected=true]:bg-elevated';
const captionActionClassName =
    'pointer-events-none shrink-0 opacity-0 transition-opacity group-hover/file-caption:pointer-events-auto group-hover/file-caption:opacity-100 group-focus-within/file-caption:pointer-events-auto group-focus-within/file-caption:opacity-100';

function InlineFileName({
    depth = 0,
    initialValue,
    label,
    onCancel,
    onSubmit,
}: {
    depth: number;
    initialValue: string;
    label: string;
    onCancel: () => void;
    onSubmit: (value: string) => Promise<void>;
}) {
    const inputRef = useRef<HTMLInputElement>(null);
    const [error, setError] = useState<string>();
    const [pending, setPending] = useState(false);
    const [value, setValue] = useState(initialValue);
    useEffect(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
    }, []);

    const submit = async (event: FormEvent): Promise<void> => {
        event.preventDefault();
        if (pending) return;
        setPending(true);
        setError(undefined);
        try {
            await onSubmit(value);
        } catch (submissionError) {
            setError(describeFailure(submissionError, 'Unable to change item'));
            setPending(false);
        }
    };

    return (
        <form onSubmit={(event) => void submit(event)}>
            <div className="flex h-7 items-center pr-2" style={{ paddingLeft: 23 + depth * 12 }}>
                <input
                    ref={inputRef}
                    aria-invalid={Boolean(error)}
                    aria-label={label}
                    className="h-6 min-w-0 flex-1 rounded-sm border border-accent bg-surface px-1 text-[12px] text-foreground outline-none"
                    disabled={pending}
                    value={value}
                    onChange={(event) => setValue(event.target.value)}
                    onKeyDown={(event) => {
                        event.stopPropagation();
                        if (event.key === 'Escape') {
                            event.preventDefault();
                            onCancel();
                        }
                    }}
                />
            </div>
            {error && (
                <div
                    role="alert"
                    className="pb-1 pr-2 text-[11px] text-danger"
                    style={{ paddingLeft: 23 + depth * 12 }}
                >
                    {error}
                </div>
            )}
        </form>
    );
}

function dragPath(event: DragEvent): string | undefined {
    return event.dataTransfer.getData(FILE_TREE_DRAG_TYPE) || undefined;
}

function hasDraggedPath(event: DragEvent): boolean {
    return event.dataTransfer.types.includes(FILE_TREE_DRAG_TYPE);
}

function DirectoryEntries({
    sessionId,
    directory,
    depth = 0,
    editing,
    selectedPath,
    setEditing,
    setSelectedPath,
}: TreeProps) {
    const {
        data: entries = [],
        isError,
        error,
    } = useCaxriQuery('files.list', { sessionId, directory });
    useToastOnQueryError(isError, error, 'Unable to read directory');

    return (
        <div className="file-list">
            {editing?.kind === 'create' && editing.directory === directory && (
                <InlineFileName
                    depth={depth}
                    initialValue=""
                    label="New file name"
                    onCancel={() => setEditing(undefined)}
                    onSubmit={async (name) => {
                        const created = await createFile(sessionId, directory, name);
                        setSelectedPath(created.path);
                        setEditing(undefined);
                    }}
                />
            )}
            {entries.map((entry) => (
                <FileTreeItem
                    key={entry.path}
                    depth={depth}
                    editing={editing}
                    entry={entry}
                    selectedPath={selectedPath}
                    sessionId={sessionId}
                    setEditing={setEditing}
                    setSelectedPath={setSelectedPath}
                />
            ))}
        </div>
    );
}

function FileTreeItem({
    entry,
    sessionId,
    depth = 0,
    editing,
    selectedPath,
    setEditing,
    setSelectedPath,
}: Omit<TreeProps, 'directory'> & { entry: FileEntry }) {
    const [expanded, setExpanded] = useState(false);
    const isRenaming = editing?.kind === 'rename' && editing.entry.path === entry.path;
    const editable = entry.kind !== 'symlink';
    const startRename = (): void => {
        if (editable) setEditing({ kind: 'rename', entry });
    };
    const confirmTrash = async (): Promise<void> => {
        if (await trashFile(sessionId, entry.path)) {
            setSelectedPath(undefined);
            setEditing(undefined);
        }
    };
    const dropIntoDirectory = (event: DragEvent): void => {
        event.preventDefault();
        event.stopPropagation();
        const source = dragPath(event);
        if (!source || entry.kind !== 'directory') return;
        void moveFile(sessionId, source, entry.path).then((moved) => {
            if (moved) setSelectedPath(moved.path);
        });
    };

    if (isRenaming)
        return (
            <InlineFileName
                depth={depth}
                initialValue={entry.name}
                label={`Rename ${entry.name}`}
                onCancel={() => setEditing(undefined)}
                onSubmit={async (name) => {
                    const moved = await renameFile(sessionId, entry.path, name);
                    setSelectedPath(moved.path);
                    setEditing(undefined);
                }}
            />
        );

    const row = (
        <button
            className={treeRowClassName}
            data-selected={selectedPath === entry.path}
            draggable={editable}
            style={{ paddingLeft: (entry.kind === 'directory' ? 8 : 23) + depth * 12 }}
            disabled={entry.kind === 'symlink'}
            title={
                entry.kind === 'symlink'
                    ? 'Symlink browsing and changes are disabled for safety'
                    : entry.path
            }
            onClick={() => {
                setSelectedPath(entry.path);
                if (entry.kind === 'directory') setExpanded((value) => !value);
                else void openFile(entry.path, { preview: true });
            }}
            onDoubleClick={() => {
                if (entry.kind === 'file') void openFile(entry.path);
            }}
            onDragOver={(event) => {
                if (entry.kind === 'directory' && hasDraggedPath(event)) event.preventDefault();
            }}
            onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData(FILE_TREE_DRAG_TYPE, entry.path);
            }}
            onDrop={dropIntoDirectory}
            onKeyDown={(event) => {
                if (event.key === 'Enter' && editable) {
                    event.preventDefault();
                    event.stopPropagation();
                    startRename();
                }
            }}
        >
            {entry.kind === 'directory' &&
                (expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />)}
            <FileTypeIcon entry={entry} expanded={expanded} />
            <span className="truncate">{entry.name}</span>
        </button>
    );

    const item = editable ? (
        <ContextMenu>
            <ContextMenuTrigger render={row} />
            <ContextMenuContent>
                {entry.kind === 'directory' && (
                    <ContextMenuItem
                        onClick={() => {
                            setExpanded(true);
                            setEditing({ kind: 'create', directory: entry.path });
                        }}
                    >
                        New File
                    </ContextMenuItem>
                )}
                <ContextMenuItem onClick={startRename}>Rename</ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => void confirmTrash()}>Move to Trash</ContextMenuItem>
            </ContextMenuContent>
        </ContextMenu>
    ) : (
        row
    );

    return (
        <div>
            {item}
            {entry.kind === 'directory' && expanded && (
                <DirectoryEntries
                    depth={depth + 1}
                    directory={entry.path}
                    editing={editing}
                    selectedPath={selectedPath}
                    sessionId={sessionId}
                    setEditing={setEditing}
                    setSelectedPath={setSelectedPath}
                />
            )}
        </div>
    );
}

export function FileTreePanel() {
    const session = useSelectedSession();
    const project = useSelectedProject();
    const sessionId = session?.id;
    const [collapseRevision, setCollapseRevision] = useState(0);
    const [editingState, setEditingState] = useState<{
        request: EditRequest;
        sessionId: string;
    }>();
    const [selectionState, setSelectionState] = useState<{
        path: string;
        sessionId: string;
    }>();
    const editing =
        editingState && editingState.sessionId === sessionId ? editingState.request : undefined;
    const selectedPath =
        selectionState && selectionState.sessionId === sessionId ? selectionState.path : undefined;
    const setEditing = (request?: EditRequest): void =>
        setEditingState(request && sessionId ? { request, sessionId } : undefined);
    const setSelectedPath = (path?: string): void =>
        setSelectionState(path && sessionId ? { path, sessionId } : undefined);
    const searchVisible = useFileSearchStore(
        (state) => Boolean(sessionId) && state.activeSessionId === sessionId,
    );
    const searchFocusRevision = useFileSearchStore((state) => state.focusRevision);
    useFileTreeInvalidation(sessionId);
    if (!session)
        return (
            <div className="empty-panel py-4 px-3 text-muted text-center">
                Create a Session to browse files.
            </div>
        );

    const tree = (
        <div
            className="min-h-0 flex-1 overflow-auto"
            onDragOver={(event) => {
                if (hasDraggedPath(event)) event.preventDefault();
            }}
            onDrop={(event) => {
                event.preventDefault();
                const source = dragPath(event);
                if (!source) return;
                void moveFile(session.id, source, session.rootPath).then((moved) => {
                    if (moved) setSelectedPath(moved.path);
                });
            }}
        >
            <DirectoryEntries
                key={`${session.id}:${collapseRevision}`}
                directory={session.rootPath}
                editing={editing}
                selectedPath={selectedPath}
                sessionId={session.id}
                setEditing={setEditing}
                setSelectedPath={setSelectedPath}
            />
        </div>
    );

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
                    <Tooltip content="New File">
                        <Button
                            className={captionActionClassName}
                            size="icon"
                            variant="ghost"
                            aria-label="New File"
                            onClick={() =>
                                setEditing({ kind: 'create', directory: session.rootPath })
                            }
                        >
                            <FilePlus size={13} />
                        </Button>
                    </Tooltip>
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
                <ContextMenu>
                    <ContextMenuTrigger render={tree} />
                    <ContextMenuContent>
                        <ContextMenuItem
                            onClick={() =>
                                setEditing({ kind: 'create', directory: session.rootPath })
                            }
                        >
                            New File
                        </ContextMenuItem>
                    </ContextMenuContent>
                </ContextMenu>
            )}
        </div>
    );
}
