import type { SubmitEvent } from 'react';
import { useEffect, useRef, useState } from 'react';

import type { FileEntry } from '@shared/types';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { ContextMenu, ContextMenuTrigger } from '../../../components/ui/context-menu';
import { Input } from '../../../components/ui/input';
import { FileTypeIcon } from '../../../icons/files/file-type-icon';
import { FILE_TREE_DRAG_TYPE, hasDraggedPath } from '../../../lib/file-drag';
import { useToastOnQueryError } from '../../../queries/client';
import { describeFailure } from '../../../stores/toasts';
import { openFile } from '../../editor/document-actions';
import { useResourceExplorerClient } from '../controlled-view-context';
import { controlledViewQueryKey } from '../view-operation-client';
import { createItem, rememberFile, renameFile } from './file-actions';
import type { PendingFileOperation } from './file-operation-state';
import { FileTreeItemMenu } from './file-tree-item-menu';
import type { EditRequest, FocusTarget } from './file-tree-item-types';
import { useFileTreeItemInteractions } from './use-file-tree-item-interactions';

export { type EditRequest, type FocusTarget };

export interface TreeProperties {
    clearFocusPath: () => void;
    depth?: number;
    directory: string;
    editing?: EditRequest;
    expandedPaths: ReadonlySet<string>;
    focusPath?: string;
    /**
     * Only the operations for the current Project; each row scopes blocking to its own subtree.
     */
    operations: readonly PendingFileOperation[];
    projectId: string;
    projectRoot: string;
    selectedPath?: string;
    sessionId: string;
    requestFocus: (target: FocusTarget) => void;
    setEditing: (editing?: EditRequest) => void;
    setPathExpanded: (
        path: string,
        isNextExpanded: boolean | ((isCurrentExpanded: boolean) => boolean),
    ) => void;
    setSelectedPath: (path?: string) => void;
}

/**
 * Every caller below fires an already-tracked file action (via `tryCommand` or the row's own
 * `try`/`catch`-and-`setError` handling) that reports its own failure, so these event handlers intentionally discard
 * the returned promise instead of awaiting it.
 */
function discard(promise: Promise<unknown>): void {
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void promise;
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
    const inputReference = useRef<HTMLInputElement>(null);
    const [error, setError] = useState<string>();
    const [pending, setPending] = useState(false);
    const [value, setValue] = useState(initialValue);
    useEffect(() => {
        inputReference.current?.focus();
        inputReference.current?.select();
    }, []);

    const submit = async (event: SubmitEvent<HTMLFormElement>): Promise<void> => {
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
        <form onSubmit={(event) => discard(submit(event))}>
            <div className="flex h-7 items-center pr-2" style={{ paddingLeft: 23 + depth * 12 }}>
                <Input
                    ref={inputReference}
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
                    className="pr-2 pb-1 text-[11px] text-danger"
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
    expandedPaths,
    operations,
    focusPath,
    projectId,
    projectRoot,
    selectedPath,
    clearFocusPath,
    requestFocus,
    setEditing,
    setPathExpanded,
    setSelectedPath,
}: TreeProperties) {
    const client = useResourceExplorerClient();
    const { data, isError, isPending, error } = useQuery({
        queryKey: controlledViewQueryKey(
            client.viewId,
            'files.list',
            { directory },
            `${sessionId}:${projectId}`,
        ),
        queryFn: ({ signal }) => client.listDirectory(directory, signal),
    });
    const entries = data?.entries ?? [];
    useToastOnQueryError(isError, error, 'Unable to read directory');
    const isComposingHere = editing?.kind === 'create' && editing.directory === directory;
    const isShowEmptyState = !isPending && !isError && entries.length === 0 && !isComposingHere;

    return (
        // Depth 0 is the root list, a direct child of the `role="tree"` container above it; only a
        // nested list (an expanded directory's children) needs `role="group"` to stay owned by its
        // parent treeitem in the accessibility tree.
        <div className="file-list" role={depth > 0 ? 'group' : undefined}>
            {isComposingHere && (
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
                            client,
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
                    expandedPaths={expandedPaths}
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
                    setPathExpanded={setPathExpanded}
                    setSelectedPath={setSelectedPath}
                />
            ))}
            {isShowEmptyState && (
                <div
                    className="px-2 py-1 text-[11px] text-muted italic"
                    style={{ paddingLeft: 23 + depth * 12 }}
                >
                    Empty folder
                </div>
            )}
            {data?.truncated && (
                <div
                    role="status"
                    aria-live="polite"
                    className="px-2 py-1 text-[11px] text-muted italic"
                    style={{ paddingLeft: 23 + depth * 12 }}
                >
                    Showing the first {entries.length.toLocaleString()} items
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
    expandedPaths,
    operations,
    focusPath,
    projectId,
    projectRoot,
    selectedPath,
    clearFocusPath,
    requestFocus,
    setEditing,
    setPathExpanded,
    setSelectedPath,
}: Omit<TreeProperties, 'directory'> & { entry: FileEntry; index: number }) {
    const client = useResourceExplorerClient();
    const {
        clipboard,
        confirmTrash,
        dragBlocked,
        dropIntoDirectory,
        duplicateBlocked,
        duplicateEntry,
        editable,
        expanded,
        handleKeyDown,
        isDropTarget,
        isRenaming,
        isRovingTabStop,
        openEntry,
        parentDirectory,
        pasteBlocked,
        pasteDisabled,
        pasteDisabledReason,
        pasteIntoEntry,
        rowRef,
        setExpanded,
        setIsDropTarget,
        startCreate,
        startRename,
        symlinkReasonId,
    } = useFileTreeItemInteractions({
        clearFocusPath,
        depth,
        editing,
        entry,
        expanded: expandedPaths.has(entry.path),
        focusPath,
        index,
        operations,
        projectId,
        selectedPath,
        sessionId,
        setExpanded: (next) => setPathExpanded(entry.path, next),
        setEditing,
        setSelectedPath,
    });

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
                    const moved = await renameFile(client, sessionId, entry.path, name);
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
                else if (editable) discard(openFile(entry.path, { preview: true }));
            }}
            onDoubleClick={() => {
                if (entry.kind === 'file') discard(openFile(entry.path));
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
                if (pasteBlocked || entry.kind !== 'directory' || !hasDraggedPath(event)) return;
                setIsDropTarget(true);
            }}
            onDragLeave={(event) => {
                // Ignore the leave fired while the pointer moves onto a child element still inside
                // this row; only clear the highlight once the pointer actually exits the row.
                if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                setIsDropTarget(false);
            }}
            onDragOver={(event) => {
                if (pasteBlocked || entry.kind !== 'directory' || !hasDraggedPath(event)) {
                    return;
                }

                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
            }}
            onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'copyMove';
                event.dataTransfer.setData(FILE_TREE_DRAG_TYPE, entry.path);
            }}
            onDrop={dropIntoDirectory}
            onPaste={(event) => {
                event.preventDefault();
                if (!pasteBlocked) discard(pasteIntoEntry());
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
            <FileTreeItemMenu
                confirmTrash={confirmTrash}
                duplicateBlocked={duplicateBlocked}
                duplicateEntry={duplicateEntry}
                entry={entry}
                openEntry={openEntry}
                parentDirectory={parentDirectory}
                pasteDisabled={pasteDisabled}
                pasteDisabledReason={pasteDisabledReason}
                pasteIntoEntry={pasteIntoEntry}
                projectId={projectId}
                projectRoot={projectRoot}
                startCreate={startCreate}
                startRename={startRename}
            />
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
                    expandedPaths={expandedPaths}
                    operations={operations}
                    focusPath={focusPath}
                    projectId={projectId}
                    projectRoot={projectRoot}
                    selectedPath={selectedPath}
                    sessionId={sessionId}
                    clearFocusPath={clearFocusPath}
                    requestFocus={requestFocus}
                    setEditing={setEditing}
                    setPathExpanded={setPathExpanded}
                    setSelectedPath={setSelectedPath}
                />
            )}
        </div>
    );
}

export { BUSY_DISABLED_REASON } from './file-tree-item-types';
