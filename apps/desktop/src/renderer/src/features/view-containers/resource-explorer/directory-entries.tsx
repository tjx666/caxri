import type { SubmitEvent } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { FileEntry } from '@caxri/protocol';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { GitFileStatusLetter } from '../../../components/git-file-status-letter';
import { ContextMenu, ContextMenuTrigger } from '../../../components/ui/context-menu';
import { Input } from '../../../components/ui/input';
import { FileTypeIcon } from '../../../icons/files/file-type-icon';
import { FILE_TREE_DRAG_TYPE, hasDraggedPath } from '../../../lib/file-drag';
import type { GitChildRepoKind, GitDecoration } from '../../../lib/git-decorations';
import { gitDecorationClassName } from '../../../lib/git-decorations';
import { cn } from '../../../lib/utilities';
import { useToastOnQueryError } from '../../../queries/client';
import { useGitChildRepo, useGitDecoration } from '../../../stores/git-decorations';
import { describeFailure } from '../../../stores/toasts';
import { useResourceExplorerClient } from '../controlled-view-context';
import {
    isViewContainerQueryEnabled,
    useCancelViewContainerQueryWhenHidden,
    useIsViewContainerActive,
} from '../view-container-activity';
import { controlledViewQueryKey } from '../view-operation-client';
import { createItem, rememberFile, renameFile } from './file-actions';
import { FileTreeItemMenu } from './file-tree-item-menu';
import type { EditRequest, FocusTarget } from './file-tree-item-types';
import { fileTreeLeafIndent, fileTreeRowStyle } from './file-tree-row-style';
import {
    clearStaleScopeFocusPath,
    setScopeSelectedPath,
    useHasScopeSelection,
    useIsPathExpanded,
    useIsPathFocusRequested,
    useIsPathSelected,
} from './resource-explorer-scope-store';
import { fileTreeRowDescription, fileTreeRowTooltip } from './resource-explorer-state';
import { useFileTreeItemInteractions } from './use-file-tree-item-interactions';

export { type EditRequest, type FocusTarget };

/**
 * Expansion, selection, focus requests, and file-operation blocking are not props: every row subscribes to its own
 * boolean in `resource-explorer-scope-store` / `useFileOperationStore`, so toggling one folder or selecting one file
 * re-renders only the rows whose state actually changed.
 */
export interface TreeProperties {
    depth?: number;
    directory: string;
    editing?: EditRequest;
    projectId: string;
    projectRoot: string;
    /**
     * `sessionId:workbenchProjectId`; keys the per-Session tree state.
     */
    scopeId: string;
    sessionId: string;
    requestFocus: (target: FocusTarget) => void;
    setEditing: (editing?: EditRequest) => void;
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

/**
 * Hover, keyboard focus, and selection are three separate `list.*` roles rather than one shared `elevated`, so a theme
 * that distinguishes them here keeps that distinction in Caxri.
 *
 * `active` and `inactive` selection follow VS Code's meaning: a list is active when it holds keyboard focus. A focused
 * row is that condition at row granularity, so the selected row takes the active fill exactly while it is focused and
 * the inactive one once focus moves elsewhere — no separate "the tree has focus" state to track. The focus ring stays
 * on top of the focus fill; a theme may set the two focus colors flat, and the ring is what still says "you are here".
 */
const treeRowClassName =
    'tree-row relative flex w-full h-7 items-center gap-2 pr-2 border-0 bg-surface text-foreground text-left cursor-pointer outline-none hover:bg-list-hover-background hover:text-list-hover-foreground focus-visible:bg-list-focus-background focus-visible:text-list-focus-foreground focus-visible:shadow-[inset_0_0_0_2px_var(--accent)] aria-disabled:text-muted aria-disabled:cursor-not-allowed data-[git-ignored=true]:text-muted data-[git-ignored=true]:italic data-[selected=true]:bg-list-inactive-selection-background data-[selected=true]:text-list-inactive-selection-foreground data-[selected=true]:focus-visible:bg-list-active-selection-background data-[selected=true]:focus-visible:text-list-active-selection-foreground data-[cut=true]:opacity-50 data-[drop-target=true]:bg-[color-mix(in_srgb,var(--accent)_18%,var(--elevated))]';

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
            <div
                className="flex h-7 items-center pr-2"
                style={{ paddingLeft: fileTreeLeafIndent(depth) }}
            >
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
                    style={{ paddingLeft: fileTreeLeafIndent(depth) }}
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
    projectId,
    projectRoot,
    scopeId,
    requestFocus,
    setEditing,
}: TreeProperties) {
    const client = useResourceExplorerClient();
    const isContainerActive = useIsViewContainerActive();
    // Listings are cached per Project, not per Session: every Session of a Project shares the same root, so a
    // Session switch reuses the loaded tree instead of clearing it and refetching each directory. Hidden keep-alive
    // panels keep that cache on screen and pause the listing until the Files tab is selected again.
    const queryKey = useMemo(
        () => controlledViewQueryKey(client.viewId, 'files.list', { directory }, projectId),
        [client.viewId, directory, projectId],
    );
    useCancelViewContainerQueryWhenHidden(queryKey, isContainerActive);
    const { data, isError, isPending, error } = useQuery({
        queryKey,
        queryFn: ({ signal }) => client.listDirectory(directory, signal),
        enabled: isViewContainerQueryEnabled(isContainerActive),
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
                        setScopeSelectedPath(scopeId, created.path);
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
                    projectId={projectId}
                    projectRoot={projectRoot}
                    scopeId={scopeId}
                    sessionId={sessionId}
                    requestFocus={requestFocus}
                    setEditing={setEditing}
                />
            ))}
            {isShowEmptyState && (
                <div
                    className="px-2 py-1 text-[11px] text-muted italic"
                    style={{ paddingLeft: fileTreeLeafIndent(depth) }}
                >
                    Empty folder
                </div>
            )}
            {data?.truncated && (
                <div
                    role="status"
                    aria-live="polite"
                    className="px-2 py-1 text-[11px] text-muted italic"
                    style={{ paddingLeft: fileTreeLeafIndent(depth) }}
                >
                    Showing the first {entries.length.toLocaleString()} items
                </div>
            )}
        </div>
    );
}

/**
 * Everything drawn inside the row button. Split out of {@link FileTreeItem}, which is left owning the row's
 * interactions, drag handling, and aria wiring.
 */
function FileTreeRowContent({
    childRepo,
    decoration,
    description,
    descriptionId,
    entry,
    expanded,
    isDirectory,
}: {
    childRepo: GitChildRepoKind | undefined;
    decoration: GitDecoration | undefined;
    /**
     * The row's `aria-describedby` text, empty when the row has nothing its name does not already say.
     */
    description: string;
    descriptionId: string;
    entry: FileEntry;
    expanded: boolean;
    isDirectory: boolean;
}) {
    return (
        <>
            {isDirectory && (expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />)}
            <FileTypeIcon childRepo={Boolean(childRepo)} entry={entry} expanded={expanded} />
            {/*
             * VS Code's Git decoration: the name takes the change's color, and only a file adds the status letter at
             * the row's trailing edge. A folder is colored by the strongest change anywhere beneath it but stays
             * letterless, because the letter would claim the folder itself changed. The file type icon keeps its own
             * color on purpose — it identifies the language, not the change.
             */}
            <span className={cn('truncate', decoration && gitDecorationClassName(decoration.kind))}>
                {entry.name}
            </span>
            {description && (
                <span id={descriptionId} className="sr-only">
                    {description}
                </span>
            )}
            {decoration && (
                <GitFileStatusLetter className="ml-auto text-[11px]" decoration={decoration} />
            )}
        </>
    );
}

function FileTreeItem({
    entry,
    index,
    sessionId,
    depth = 0,
    editing,
    projectId,
    projectRoot,
    scopeId,
    requestFocus,
    setEditing,
}: Omit<TreeProperties, 'directory'> & { entry: FileEntry; index: number }) {
    const client = useResourceExplorerClient();
    const decoration = useGitDecoration(entry.path);
    const childRepo = useGitChildRepo(entry.path);
    const expanded = useIsPathExpanded(scopeId, entry.path);
    const selected = useIsPathSelected(scopeId, entry.path);
    const hasSelection = useHasScopeSelection(scopeId);
    const isFocusRequested = useIsPathFocusRequested(scopeId, entry.path);
    const {
        activateEntry,
        clipboard,
        confirmTrash,
        dragBlocked,
        dropIntoDirectory,
        duplicateBlocked,
        duplicateEntry,
        editable,
        handleKeyDown,
        isDropTarget,
        isDirectory,
        isRenaming,
        isRovingTabStop,
        openEntry,
        parentDirectory,
        pasteBlocked,
        pasteDisabled,
        pasteDisabledReason,
        pasteIntoEntry,
        rowRef,
        setIsDropTarget,
        startCreate,
        startRename,
        rowDescriptionId,
    } = useFileTreeItemInteractions({
        depth,
        editing,
        entry,
        expanded,
        hasSelection,
        index,
        isFocusRequested,
        isSelected: selected,
        projectId,
        scopeId,
        sessionId,
        setEditing,
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
                    setScopeSelectedPath(scopeId, moved.path);
                    setEditing(undefined);
                    requestFocus({ kind: 'path', path: moved.path });
                }}
            />
        );

    const rowDescription = fileTreeRowDescription(entry, childRepo, decoration);

    const row = (
        <button
            ref={rowRef}
            role="treeitem"
            /*
             * Named explicitly rather than from content, the way a Source Control row is. The row also holds the
             * `sr-only` description below, and name-from-content would otherwise swallow it — a modified file would
             * announce, and match `getByRole`, as "tracked.ts Git: modified." instead of "tracked.ts".
             */
            aria-label={entry.name}
            aria-describedby={rowDescription ? rowDescriptionId : undefined}
            aria-expanded={isDirectory ? expanded : undefined}
            aria-level={depth + 1}
            aria-selected={selected}
            tabIndex={isRovingTabStop ? 0 : -1}
            className={treeRowClassName}
            data-cut={clipboard?.mode === 'cut' && clipboard.path === entry.path}
            data-drop-target={isDropTarget}
            data-git-ignored={entry.gitIgnored}
            data-selected={selected}
            draggable={editable && !dragBlocked}
            style={fileTreeRowStyle({
                depth,
                isDirectory,
                isExpanded: expanded,
            })}
            title={fileTreeRowTooltip(entry, childRepo)}
            onClick={(event) =>
                discard(
                    activateEntry({
                        preview: true,
                        toggleDirectory: true,
                        recursive: event.altKey,
                    }),
                )
            }
            onDoubleClick={() => discard(activateEntry())}
            onFocus={() => clearStaleScopeFocusPath(scopeId, entry.path)}
            onContextMenu={() => setScopeSelectedPath(scopeId, entry.path)}
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
            <FileTreeRowContent
                childRepo={childRepo}
                decoration={decoration}
                description={rowDescription}
                descriptionId={rowDescriptionId}
                entry={entry}
                expanded={expanded}
                isDirectory={isDirectory}
            />
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
            {isDirectory && expanded && (
                <DirectoryEntries
                    depth={depth + 1}
                    directory={entry.path}
                    editing={editing}
                    projectId={projectId}
                    projectRoot={projectRoot}
                    scopeId={scopeId}
                    sessionId={sessionId}
                    requestFocus={requestFocus}
                    setEditing={setEditing}
                />
            )}
        </div>
    );
}

export { BUSY_DISABLED_REASON } from './file-tree-item-types';
