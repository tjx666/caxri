import type { SubmitEvent } from 'react';
import { useEffect, useRef, useState } from 'react';

import type { FileEntry } from '@caxri/protocol';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { GitFileStatusLetter } from '../../../components/git-file-status-letter';
import { Input } from '../../../components/ui/input';
import { useContextMenu } from '../../../hooks/use-context-menu';
import { FileTypeIcon } from '../../../icons/files/file-type-icon';
import { hasDraggedPath, startFilePathDrag } from '../../../lib/file-drag';
import type { GitChildRepoKind, GitDecoration } from '../../../lib/git-decorations';
import { gitDecorationClassName } from '../../../lib/git-decorations';
import { cn } from '../../../lib/utilities';
import { useGitChildRepo, useGitDecoration } from '../../../stores/git-decorations';
import { describeFailure } from '../../../stores/toasts';
import { useResourceExplorerClient } from '../controlled-view-context';
import { createItem, rememberFile, renameFile } from './file-actions';
import { fileTreeItemMenu } from './file-tree-item-menu';
import type { EditRequest, FocusTarget } from './file-tree-item-types';
import { fileTreeLeafIndent, fileTreeRowStyle } from './file-tree-row-style';
import { useFileTreeItemInteractions } from './hooks/use-file-tree-item-interactions';
import {
    activeResourceExplorerScope,
    clearStaleScopeFocusPath,
    setScopeSelectedPath,
    useHasScopeSelection,
    useIsPathExpanded,
    useIsPathFocusRequested,
    useIsPathSelected,
} from './resource-explorer-scope-store';
import { fileTreeRowDescription, fileTreeRowTooltip } from './resource-explorer-state';

/**
 * Expansion, selection, focus requests, and file-operation blocking are not props: every row subscribes to its own
 * boolean in `resource-explorer-scope-store` / `useFileOperationStore`, so toggling one folder or selecting one file
 * re-renders only the rows whose state actually changed.
 *
 * The Session identity behind those booleans is not a prop either, for the same reason one level up: it lives in the
 * scope store, so switching Session re-renders only the rows whose own state differs in the new scope.
 */
export interface FileTreeItemProperties {
    depth: number;
    editing?: EditRequest;
    entry: FileEntry;
    /**
     * Zero-based position within the parent listing.
     */
    index: number;
    projectId: string;
    projectRoot: string;
    requestFocus: (target: FocusTarget) => void;
    setEditing: (editing?: EditRequest) => void;
    /**
     * Number of entries in the parent listing, for `aria-setsize`.
     */
    setSize: number;
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
 * the inactive one once focus moves elsewhere: no separate "the tree has focus" state to track. The focus ring stays on
 * top of the focus fill; a theme may set the two focus colors flat, and the ring is what still says "you are here".
 */
const treeRowClassName =
    'tree-row relative flex w-full h-7 items-center gap-2 pr-2 border-0 bg-surface text-foreground text-left cursor-pointer outline-none hover:bg-list-hover-background hover:text-list-hover-foreground focus-visible:bg-list-focus-background focus-visible:text-list-focus-foreground focus-visible:shadow-[inset_0_0_0_2px_var(--accent)] aria-disabled:text-muted aria-disabled:cursor-not-allowed data-[git-ignored=true]:text-muted data-[git-ignored=true]:italic data-[selected=true]:bg-list-inactive-selection-background data-[selected=true]:text-list-inactive-selection-foreground data-[selected=true]:focus-visible:bg-list-active-selection-background data-[selected=true]:focus-visible:text-list-active-selection-foreground data-[cut=true]:opacity-50 data-[drop-target=true]:bg-[color-mix(in_srgb,var(--accent)_18%,var(--elevated))]';

function InlineFileName({
    depth = 0,
    initialValue,
    label,
    failureLabel,
    onCancel,
    onSubmit,
}: {
    depth: number;
    initialValue: string;
    label: string;
    failureLabel: string;
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
            setError(describeFailure(submissionError, failureLabel));
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

/**
 * The inline "New file" / "New folder" field, drawn as its own row at the top of the directory it creates into.
 */
export function FileTreeCreateRow({
    depth,
    directory,
    editing,
    requestFocus,
    setEditing,
}: {
    depth: number;
    directory: string;
    editing: Extract<EditRequest, { kind: 'create' }>;
    requestFocus: (target: FocusTarget) => void;
    setEditing: (editing?: EditRequest) => void;
}) {
    const client = useResourceExplorerClient();
    return (
        <InlineFileName
            depth={depth}
            initialValue=""
            label={editing.itemKind === 'directory' ? 'New folder name' : 'New file name'}
            failureLabel={
                editing.itemKind === 'directory'
                    ? 'Unable to create folder'
                    : 'Unable to create file'
            }
            onCancel={() => {
                setEditing(undefined);
                requestFocus(editing.returnFocus);
            }}
            onSubmit={async (name) => {
                const scope = activeResourceExplorerScope();
                if (!scope) return;
                const created = await createItem(
                    client,
                    scope.sessionId,
                    directory,
                    name,
                    editing.itemKind,
                );
                if (!created) {
                    setEditing(undefined);
                    requestFocus(editing.returnFocus);
                    return;
                }
                setScopeSelectedPath(scope.scopeId, created.path);
                setEditing(undefined);
                requestFocus({ kind: 'path', path: created.path });
            }}
        />
    );
}

/**
 * The "Empty folder" and "Showing the first N items" notices under a listing.
 */
export function FileTreeNotice({
    depth,
    truncatedCount,
}: {
    depth: number;
    truncatedCount?: number;
}) {
    return truncatedCount === undefined ? (
        <div
            className="px-2 py-1 text-[11px] text-muted italic"
            style={{ paddingLeft: fileTreeLeafIndent(depth) }}
        >
            Empty folder
        </div>
    ) : (
        <div
            role="status"
            aria-live="polite"
            className="px-2 py-1 text-[11px] text-muted italic"
            style={{ paddingLeft: fileTreeLeafIndent(depth) }}
        >
            Showing the first {truncatedCount.toLocaleString()} items
        </div>
    );
}

/**
 * Everything drawn inside the row button. Split out of {@link FileTreeItem}, which is left owning the row's
 * interactions, drag handling, and aria wiring.
 */
export function FileTreeRowContent({
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
            <FileTypeIcon childRepo={childRepo} entry={entry} expanded={expanded} />
            {/*
             * VS Code's Git decoration: the name takes the change's color, and only a file adds the status letter at
             * the row's trailing edge. A folder is colored by the strongest change anywhere beneath it but stays
             * letterless, because the letter would claim the folder itself changed. The file type icon keeps its own
             * color on purpose; it identifies the language, not the change.
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

export function FileTreeItem({
    entry,
    index,
    depth,
    editing,
    projectId,
    projectRoot,
    requestFocus,
    setEditing,
    setSize,
}: FileTreeItemProperties) {
    const client = useResourceExplorerClient();
    const decoration = useGitDecoration(entry.path);
    const childRepo = useGitChildRepo(entry.path);
    const expanded = useIsPathExpanded(entry.path);
    const selected = useIsPathSelected(entry.path);
    const hasSelection = useHasScopeSelection();
    const isFocusRequested = useIsPathFocusRequested(entry.path);
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
        setEditing,
    });

    const openContextMenu = useContextMenu(() =>
        fileTreeItemMenu({
            confirmTrash,
            duplicateBlocked,
            duplicateEntry,
            entry,
            openEntry,
            parentDirectory,
            pasteDisabledReason,
            pasteIntoEntry,
            projectId,
            projectRoot,
            startCreate,
            startRename,
        }),
    );

    if (isRenaming)
        return (
            <InlineFileName
                depth={depth}
                initialValue={entry.name}
                label={`Rename ${entry.name}`}
                failureLabel="Unable to rename item"
                onCancel={() => {
                    setEditing(undefined);
                    requestFocus({ kind: 'path', path: entry.path });
                }}
                onSubmit={async (name) => {
                    const scope = activeResourceExplorerScope();
                    if (!scope) return;
                    const moved = await renameFile(client, scope.sessionId, entry.path, name);
                    if (!moved) {
                        setEditing(undefined);
                        requestFocus({ kind: 'path', path: entry.path });
                        return;
                    }
                    setScopeSelectedPath(scope.scopeId, moved.path);
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
             * `sr-only` description below, and name-from-content would otherwise swallow it: a modified file would
             * announce, and match `getByRole`, as "tracked.ts Git: modified." instead of "tracked.ts".
             */
            aria-label={entry.name}
            aria-describedby={rowDescription ? rowDescriptionId : undefined}
            aria-expanded={isDirectory ? expanded : undefined}
            aria-level={depth + 1}
            aria-posinset={index + 1}
            aria-selected={selected}
            aria-setsize={setSize}
            tabIndex={isRovingTabStop ? 0 : -1}
            className={treeRowClassName}
            data-cut={clipboard?.mode === 'cut' && clipboard.path === entry.path}
            data-drop-target={isDropTarget}
            data-git-ignored={entry.gitIgnored}
            data-selected={selected}
            draggable={!dragBlocked}
            style={fileTreeRowStyle({ depth, isDirectory })}
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
            onFocus={() => {
                const scope = activeResourceExplorerScope();
                if (scope) clearStaleScopeFocusPath(scope.scopeId, entry.path);
            }}
            onContextMenu={(event) => {
                const scope = activeResourceExplorerScope();
                if (scope) setScopeSelectedPath(scope.scopeId, entry.path);
                /**
                 * A symlink row has no menu of its own; leaving its gesture unclaimed lets it reach the tree's
                 * background menu, as it always has.
                 */
                if (editable) openContextMenu(event);
            }}
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
                startFilePathDrag(event.dataTransfer, entry.path, editable);
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

    return row;
}
