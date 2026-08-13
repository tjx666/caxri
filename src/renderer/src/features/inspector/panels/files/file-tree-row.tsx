import { ChevronDown, ChevronRight } from 'lucide-react';
import {
    useEffect,
    useId,
    useRef,
    useState,
    type DragEvent,
    type FormEvent,
    type KeyboardEvent,
} from 'react';

import type { FileEntry } from '@shared/types';

import { Input } from '../../../../components/ui/input';
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
} from '../../../../components/ui/context-menu';
import { FileTypeIcon } from '../../../../icons/files/FileTypeIcon';
import { useCaxriQuery, useToastOnQueryError } from '../../../../queries/client';
import { describeFailure } from '../../../../stores/toasts';
import { openFile } from '../../../editor/document-actions';
import {
    copyFilePath,
    duplicateFile,
    moveFile,
    openFileInTerminal,
    pasteFile,
    createItem,
    rememberFile,
    renameFile,
    revealFile,
    trashFile,
} from './file-actions';
import { useFileClipboardStore } from './file-clipboard';
import { dragPath, FILE_TREE_DRAG_TYPE, hasDraggedPath } from './file-tree-drag';
import { isPathBlockedByFileOperations, type PendingFileOperation } from './file-operation-state';
import {
    focusAdjacentTreeItem,
    focusParentTreeItem,
    focusTreeItemEdge,
} from './file-tree-navigation';
import { parentDirectoryPath } from './file-tree-refresh';

/** Shared copy for every Paste/Duplicate/Drag affordance disabled by an in-flight file operation. */
export const BUSY_DISABLED_REASON = 'Busy — a file operation is in progress here';

export type EditRequest =
    | {
          kind: 'create';
          directory: string;
          itemKind: 'file' | 'directory';
          returnFocus: FocusTarget;
      }
    | { kind: 'rename'; entry: FileEntry };

export type FocusTarget =
    { kind: 'caption'; itemKind: 'file' | 'directory' } | { kind: 'path'; path: string };

export interface TreeProps {
    clearFocusPath: () => void;
    depth?: number;
    directory: string;
    editing?: EditRequest;
    focusPath?: string;
    /** Only the operations for the current Project; each row scopes blocking to its own subtree. */
    operations: readonly PendingFileOperation[];
    projectId: string;
    projectRoot: string;
    selectedPath?: string;
    sessionId: string;
    requestFocus: (target: FocusTarget) => void;
    setEditing: (editing?: EditRequest) => void;
    setSelectedPath: (path?: string) => void;
}

const treeRowClassName =
    'tree-row relative flex w-full h-7 items-center gap-2 pr-2 border-0 bg-surface text-foreground text-left cursor-pointer outline-none hover:bg-elevated focus-visible:shadow-[inset_0_0_0_2px_var(--accent)] aria-disabled:text-muted aria-disabled:cursor-not-allowed data-[git-ignored=true]:text-muted data-[git-ignored=true]:italic data-[selected=true]:bg-elevated data-[cut=true]:opacity-50 data-[drop-target=true]:bg-[color-mix(in_srgb,var(--accent)_18%,var(--elevated))]';

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
        } finally {
            setPending(false);
        }
    };

    return (
        <form onSubmit={(event) => void submit(event)}>
            <div className="flex h-7 items-center pr-2" style={{ paddingLeft: 23 + depth * 12 }}>
                <Input
                    ref={inputRef}
                    aria-invalid={Boolean(error)}
                    aria-label={label}
                    appearance="inline"
                    className="flex-1 text-foreground"
                    disabled={pending}
                    size="compact"
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

export function DirectoryEntries({
    sessionId,
    directory,
    depth = 0,
    editing,
    operations,
    focusPath,
    projectId,
    projectRoot,
    selectedPath,
    clearFocusPath,
    requestFocus,
    setEditing,
    setSelectedPath,
}: TreeProps) {
    const {
        data: entries = [],
        isError,
        isPending,
        error,
    } = useCaxriQuery('files.list', { sessionId, directory });
    useToastOnQueryError(isError, error, 'Unable to read directory');
    const composingHere = editing?.kind === 'create' && editing.directory === directory;
    const showEmptyState = !isPending && !isError && entries.length === 0 && !composingHere;

    return (
        // Depth 0 is the root list, a direct child of the `role="tree"` container above it; only a
        // nested list (an expanded directory's children) needs `role="group"` to stay owned by its
        // parent treeitem in the accessibility tree.
        <div className="file-list" role={depth > 0 ? 'group' : undefined}>
            {composingHere && (
                <InlineFileName
                    depth={depth}
                    initialValue=""
                    label={editing.itemKind === 'directory' ? 'New folder name' : 'New file name'}
                    onCancel={() => {
                        setEditing(undefined);
                        requestFocus(editing.returnFocus);
                    }}
                    onSubmit={async (name) => {
                        const created = await createItem(
                            sessionId,
                            directory,
                            name,
                            editing.itemKind,
                        );
                        if (!created) {
                            setEditing(undefined);
                            requestFocus(editing.returnFocus);
                            return;
                        }
                        setSelectedPath(created.path);
                        setEditing(undefined);
                        requestFocus({ kind: 'path', path: created.path });
                    }}
                />
            )}
            {entries.map((entry, index) => (
                <FileTreeItem
                    key={entry.path}
                    depth={depth}
                    editing={editing}
                    entry={entry}
                    index={index}
                    operations={operations}
                    focusPath={focusPath}
                    projectId={projectId}
                    projectRoot={projectRoot}
                    selectedPath={selectedPath}
                    sessionId={sessionId}
                    clearFocusPath={clearFocusPath}
                    requestFocus={requestFocus}
                    setEditing={setEditing}
                    setSelectedPath={setSelectedPath}
                />
            ))}
            {showEmptyState && (
                <div
                    className="px-2 py-1 text-[11px] text-muted italic"
                    style={{ paddingLeft: 23 + depth * 12 }}
                >
                    Empty folder
                </div>
            )}
        </div>
    );
}

function FileTreeItem({
    entry,
    index,
    sessionId,
    depth = 0,
    editing,
    operations,
    focusPath,
    projectId,
    projectRoot,
    selectedPath,
    clearFocusPath,
    requestFocus,
    setEditing,
    setSelectedPath,
}: Omit<TreeProps, 'directory'> & { entry: FileEntry; index: number }) {
    const [expanded, setExpanded] = useState(false);
    const [isDropTarget, setIsDropTarget] = useState(false);
    const rowRef = useRef<HTMLButtonElement>(null);
    const symlinkReasonId = useId();
    const clipboard = useFileClipboardStore((state) => state.entry);
    const isRenaming = editing?.kind === 'rename' && editing.entry.path === entry.path;
    const editable = entry.kind !== 'symlink';
    const parentDirectory = parentDirectoryPath(entry.path);
    const pasteDirectory = entry.kind === 'directory' ? entry.path : parentDirectory;
    const clipboardEmpty = !clipboard || clipboard.projectId !== projectId;
    const pasteBlocked = isPathBlockedByFileOperations(operations, projectId, pasteDirectory);
    const pasteDisabled = clipboardEmpty || pasteBlocked;
    const pasteDisabledReason = clipboardEmpty
        ? 'Nothing to paste'
        : pasteBlocked
          ? BUSY_DISABLED_REASON
          : undefined;
    const duplicateBlocked = isPathBlockedByFileOperations(operations, projectId, parentDirectory);
    const dragBlocked =
        isPathBlockedByFileOperations(operations, projectId, entry.path) ||
        isPathBlockedByFileOperations(operations, projectId, parentDirectory);
    /**
     * Roving tabindex: exactly one row in the whole tree is a Tab stop. The selected row owns it;
     * with no selection, the very first root-level row is the fallback so Tab always lands
     * somewhere sensible instead of nowhere.
     */
    const isRovingTabStop = selectedPath ? selectedPath === entry.path : depth === 0 && index === 0;

    const startRename = (): void => {
        if (editable) setEditing({ kind: 'rename', entry });
    };
    const startCreate = (itemKind: 'file' | 'directory'): void => {
        if (entry.kind !== 'directory') return;
        setExpanded(true);
        setEditing({
            kind: 'create',
            directory: entry.path,
            itemKind,
            returnFocus: { kind: 'path', path: entry.path },
        });
    };
    const openEntry = (): void => {
        if (entry.kind === 'directory') setExpanded(true);
        else void openFile(entry.path);
    };
    const pasteIntoEntry = async (): Promise<void> => {
        const currentClipboard = useFileClipboardStore.getState().entry;
        if (!currentClipboard) return;
        const pasted = await pasteFile(sessionId, projectId, pasteDirectory, currentClipboard);
        if (pasted) setSelectedPath(pasted.path);
    };
    const duplicateEntry = async (): Promise<void> => {
        const copied = await duplicateFile(sessionId, entry.path);
        if (copied) setSelectedPath(copied.path);
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
        setIsDropTarget(false);
        const source = dragPath(event);
        if (pasteBlocked) return;
        if (!source || entry.kind !== 'directory') return;
        void moveFile(sessionId, source, entry.path).then((moved) => {
            if (moved) setSelectedPath(moved.path);
        });
    };
    const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            focusAdjacentTreeItem(event.currentTarget, 1);
            return;
        }
        if (event.key === 'ArrowUp') {
            event.preventDefault();
            focusAdjacentTreeItem(event.currentTarget, -1);
            return;
        }
        if (event.key === 'Home') {
            event.preventDefault();
            focusTreeItemEdge(event.currentTarget, 'first');
            return;
        }
        if (event.key === 'End') {
            event.preventDefault();
            focusTreeItemEdge(event.currentTarget, 'last');
            return;
        }
        if (event.key === 'ArrowRight') {
            if (entry.kind !== 'directory') return;
            event.preventDefault();
            // Collapsed -> expand in place; already expanded -> move focus into the first child,
            // matching the standard ARIA treeview keyboard pattern.
            if (!expanded) setExpanded(true);
            else focusAdjacentTreeItem(event.currentTarget, 1);
            return;
        }
        if (event.key === 'ArrowLeft') {
            event.preventDefault();
            if (entry.kind === 'directory' && expanded) setExpanded(false);
            else focusParentTreeItem(event.currentTarget);
            return;
        }
        if (event.key === 'Enter' && editable) {
            event.preventDefault();
            event.stopPropagation();
            startRename();
            return;
        }
        if (!event.metaKey || !editable) return;
        const key = event.key.toLowerCase();
        if (!['backspace', 'c', 'v', 'x'].includes(key)) return;
        event.preventDefault();
        event.stopPropagation();
        if (key === 'backspace') void confirmTrash();
        else if (key === 'c') rememberFile(projectId, entry.path, 'copy');
        else if (key === 'x') rememberFile(projectId, entry.path, 'cut');
        else if (!pasteBlocked) void pasteIntoEntry();
    };

    useEffect(() => {
        if (focusPath !== entry.path || isRenaming) return;
        rowRef.current?.focus();
        clearFocusPath();
    }, [clearFocusPath, entry.path, focusPath, isRenaming]);

    if (isRenaming)
        return (
            <InlineFileName
                depth={depth}
                initialValue={entry.name}
                label={`Rename ${entry.name}`}
                onCancel={() => {
                    setEditing(undefined);
                    requestFocus({ kind: 'path', path: entry.path });
                }}
                onSubmit={async (name) => {
                    const moved = await renameFile(sessionId, entry.path, name);
                    if (!moved) {
                        setEditing(undefined);
                        requestFocus({ kind: 'path', path: entry.path });
                        return;
                    }
                    setSelectedPath(moved.path);
                    setEditing(undefined);
                    requestFocus({ kind: 'path', path: moved.path });
                }}
            />
        );

    const row = (
        <button
            ref={rowRef}
            role="treeitem"
            aria-describedby={entry.kind === 'symlink' ? symlinkReasonId : undefined}
            aria-disabled={editable ? undefined : true}
            aria-expanded={entry.kind === 'directory' ? expanded : undefined}
            aria-level={depth + 1}
            aria-selected={selectedPath === entry.path}
            tabIndex={isRovingTabStop ? 0 : -1}
            className={treeRowClassName}
            data-cut={clipboard?.mode === 'cut' && clipboard.path === entry.path}
            data-drop-target={isDropTarget}
            data-git-ignored={entry.gitIgnored}
            data-selected={selectedPath === entry.path}
            draggable={editable && !dragBlocked}
            style={{ paddingLeft: (entry.kind === 'directory' ? 8 : 23) + depth * 12 }}
            title={
                entry.kind === 'symlink'
                    ? 'Symlink browsing and changes are disabled for safety'
                    : entry.gitIgnored
                      ? `${entry.path} (Git ignored)`
                      : entry.path
            }
            onClick={() => {
                setSelectedPath(entry.path);
                if (entry.kind === 'directory') setExpanded((value) => !value);
                else if (editable) void openFile(entry.path, { preview: true });
            }}
            onDoubleClick={() => {
                if (entry.kind === 'file') void openFile(entry.path);
            }}
            onFocus={() => {
                if (focusPath && focusPath !== entry.path) clearFocusPath();
            }}
            onContextMenu={() => setSelectedPath(entry.path)}
            onCopy={(event) => {
                event.preventDefault();
                rememberFile(projectId, entry.path, 'copy');
            }}
            onCut={(event) => {
                event.preventDefault();
                rememberFile(projectId, entry.path, 'cut');
            }}
            onDragEnter={(event) => {
                if (entry.kind !== 'directory' || pasteBlocked || !hasDraggedPath(event)) return;
                setIsDropTarget(true);
            }}
            onDragLeave={(event) => {
                // Ignore the leave fired while the pointer moves onto a child element still inside
                // this row; only clear the highlight once the pointer actually exits the row.
                if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                setIsDropTarget(false);
            }}
            onDragOver={(event) => {
                if (!pasteBlocked && entry.kind === 'directory' && hasDraggedPath(event))
                    event.preventDefault();
            }}
            onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData(FILE_TREE_DRAG_TYPE, entry.path);
            }}
            onDrop={dropIntoDirectory}
            onPaste={(event) => {
                event.preventDefault();
                if (!pasteBlocked) void pasteIntoEntry();
            }}
            onKeyDown={handleKeyDown}
        >
            {entry.kind === 'directory' &&
                (expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />)}
            <FileTypeIcon entry={entry} expanded={expanded} />
            <span className="truncate">{entry.name}</span>
            {entry.kind === 'symlink' && (
                <span id={symlinkReasonId} className="sr-only">
                    Symlink browsing and changes are disabled for safety
                </span>
            )}
        </button>
    );

    const item = editable ? (
        <ContextMenu>
            <ContextMenuTrigger render={row} />
            <ContextMenuContent>
                <ContextMenuItem onClick={openEntry}>Open</ContextMenuItem>
                <ContextMenuItem onClick={() => void revealFile(sessionId, entry.path)}>
                    Reveal in Finder
                </ContextMenuItem>
                <ContextMenuItem
                    onClick={() =>
                        void openFileInTerminal(
                            entry.kind === 'directory' ? entry.path : parentDirectory,
                        )
                    }
                >
                    Open in Terminal
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                    hint="cmd+x"
                    onClick={() => rememberFile(projectId, entry.path, 'cut')}
                >
                    Cut
                </ContextMenuItem>
                <ContextMenuItem
                    hint="cmd+c"
                    onClick={() => rememberFile(projectId, entry.path, 'copy')}
                >
                    Copy
                </ContextMenuItem>
                {/* Always shown so Paste's availability (and why it's unavailable) is discoverable
                    from the mouse menu instead of only surfacing through a Cmd+V error toast. */}
                <ContextMenuItem
                    disabled={pasteDisabled}
                    disabledReason={pasteDisabledReason}
                    hint={pasteDisabled ? undefined : 'cmd+v'}
                    onClick={() => void pasteIntoEntry()}
                >
                    Paste
                </ContextMenuItem>
                <ContextMenuItem
                    disabled={duplicateBlocked}
                    disabledReason={duplicateBlocked ? BUSY_DISABLED_REASON : undefined}
                    onClick={() => void duplicateEntry()}
                >
                    Duplicate
                </ContextMenuItem>
                <ContextMenuItem onClick={() => void copyFilePath(entry.path)}>
                    Copy Path
                </ContextMenuItem>
                <ContextMenuItem onClick={() => void copyFilePath(entry.path, projectRoot)}>
                    Copy Relative Path
                </ContextMenuItem>
                <ContextMenuSeparator />
                {entry.kind === 'directory' && (
                    <>
                        <ContextMenuItem onClick={() => startCreate('file')}>
                            New File
                        </ContextMenuItem>
                        <ContextMenuItem onClick={() => startCreate('directory')}>
                            New Folder
                        </ContextMenuItem>
                    </>
                )}
                <ContextMenuItem hint="enter" onClick={startRename}>
                    Rename
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem hint="cmd+backspace" onClick={() => void confirmTrash()}>
                    Move to Trash
                </ContextMenuItem>
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
                    operations={operations}
                    focusPath={focusPath}
                    projectId={projectId}
                    projectRoot={projectRoot}
                    selectedPath={selectedPath}
                    sessionId={sessionId}
                    clearFocusPath={clearFocusPath}
                    requestFocus={requestFocus}
                    setEditing={setEditing}
                    setSelectedPath={setSelectedPath}
                />
            )}
        </div>
    );
}
