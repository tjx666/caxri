import type { DragEvent } from 'react';
import { useEffect, useRef, useState } from 'react';

import { FilePlus, FolderPlus, Search, SquareMinus } from 'lucide-react';

import { executeCommand } from '../../../../commands/execute';
import { Button } from '../../../../components/ui/button';
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
} from '../../../../components/ui/context-menu';
import { CommandTooltip, Tooltip } from '../../../../components/ui/tooltip';
import { cn } from '../../../../lib/utilities';
import { useSelectedSession, useSelectedWorkbenchProject } from '../../../../stores/selectors';
import type { EditRequest, FocusTarget } from './directory-entries';
import { BUSY_DISABLED_REASON, DirectoryEntries } from './directory-entries';
import { cancelFileOperation, moveFile, pasteFile } from './file-actions';
import { useFileClipboardStore } from './file-clipboard';
import { FileConflictDialog } from './file-conflict-dialog';
import type { PendingFileOperation } from './file-operation-state';
import {
    CANCEL_REVEAL_THRESHOLD_MS,
    isPathBlockedByFileOperations,
    useFileOperationStore,
} from './file-operation-state';
import { closeFileSearch, useFileSearchStore } from './file-search-state';
import { dragPath, hasDraggedPath } from './file-tree-drag';
import { ProjectSearch } from './project-search';

const captionActionClassName =
    'pointer-events-none shrink-0 opacity-0 transition-opacity group-hover/file-caption:pointer-events-auto group-hover/file-caption:opacity-100 group-focus-within/file-caption:pointer-events-auto group-focus-within/file-caption:opacity-100';

/**
 * A Cancel affordance would be noisy if it appeared for every fast operation, so it only reveals once
 * `pendingOperation` has been running past `CANCEL_REVEAL_THRESHOLD_MS`. `Date.now()` is impure and React's render
 * phase must stay pure, so every state update — including the already-past-threshold case — goes through a `setTimeout`
 * callback (0ms when the threshold has already elapsed) instead of a synchronous `setState` call in the effect body.
 * This mirrors the shared `useDebouncedValue` hook (`@/hooks/use-debounced-value`), which defers its own correction the
 * same way.
 */
function useIsCancelRevealed(operation: PendingFileOperation | undefined): boolean {
    const [isRevealed, setIsRevealed] = useState(false);
    const isCancelable = operation?.cancelable ?? false;
    const startedAt = operation?.startedAt;
    useEffect(() => {
        if (!isCancelable || startedAt === undefined) {
            const timer = setTimeout(() => setIsRevealed(false), 0);
            return () => clearTimeout(timer);
        }
        const remaining = startedAt + CANCEL_REVEAL_THRESHOLD_MS - Date.now();
        const timer = setTimeout(() => setIsRevealed(true), Math.max(remaining, 0));
        return () => clearTimeout(timer);
    }, [isCancelable, startedAt]);
    return isRevealed;
}

/**
 * Every caller below fires an already-tracked file action whose own `tryCommand`-backed path reports failures via a
 * toast, so these event handlers intentionally discard the returned promise instead of awaiting it.
 */
function discard(promise: Promise<unknown>): void {
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void promise;
}

export function FileTreePanel() {
    const session = useSelectedSession();
    const project = useSelectedWorkbenchProject();
    const sessionId = session?.id;
    const scopeId = session ? `${session.id}:${session.workbenchProjectId}` : undefined;
    const clipboard = useFileClipboardStore((state) => state.entry);
    const selectedProjectId = project?.id ?? session?.workbenchProjectId;
    const operations = useFileOperationStore((state) => state.operations);
    const projectOperations = operations.filter(
        (operation) => operation.projectId === selectedProjectId,
    );
    const pendingOperation = projectOperations[0];
    const isCancelRevealed = useIsCancelRevealed(pendingOperation);
    const fileCaptionReference = useRef<HTMLDivElement>(null);
    const [collapseRevision, setCollapseRevision] = useState(0);
    const [expandedByScope, setExpandedByScope] = useState<Record<string, string[]>>({});
    const [editingState, setEditingState] = useState<{
        request: EditRequest;
        scopeId: string;
    }>();
    const [focusByScope, setFocusByScope] = useState<Record<string, string | undefined>>({});
    const [selectionByScope, setSelectionByScope] = useState<Record<string, string | undefined>>(
        {},
    );
    const editing =
        editingState && editingState.scopeId === scopeId ? editingState.request : undefined;
    const focusPath = scopeId ? focusByScope[scopeId] : undefined;
    const selectedPath = scopeId ? selectionByScope[scopeId] : undefined;
    const setEditing = (request?: EditRequest): void =>
        setEditingState(request && scopeId ? { request, scopeId } : undefined);
    const setSelectedPath = (path?: string): void => {
        if (scopeId) setSelectionByScope((current) => ({ ...current, [scopeId]: path }));
    };
    const clearFocusPath = (): void => {
        if (scopeId) setFocusByScope((current) => ({ ...current, [scopeId]: undefined }));
    };
    const requestFocus = (target: FocusTarget): void => {
        if (target.kind === 'path') {
            if (scopeId) setFocusByScope((current) => ({ ...current, [scopeId]: target.path }));
            return;
        }
        clearFocusPath();
        const label = target.itemKind === 'file' ? 'New File' : 'New Folder';
        fileCaptionReference.current
            ?.querySelector<HTMLButtonElement>(`button[aria-label="${CSS.escape(label)}"]`)
            ?.focus();
    };
    const isSearchVisible = useFileSearchStore(
        (state) => Boolean(sessionId) && state.activeSessionId === sessionId,
    );
    const searchFocusRevision = useFileSearchStore((state) => state.focusRevision);
    if (!session)
        return (
            <div className="empty-panel px-3 py-4 text-center text-muted">
                Create a Session to browse files.
            </div>
        );
    const projectId = selectedProjectId ?? session.workbenchProjectId;
    const expandedPaths = new Set(scopeId ? (expandedByScope[scopeId] ?? []) : []);
    const setPathExpanded = (
        path: string,
        isNextExpanded: boolean | ((isCurrentExpanded: boolean) => boolean),
    ): void => {
        if (!scopeId) return;
        setExpandedByScope((current) => {
            const paths = new Set(current[scopeId]);
            const isExpanded =
                typeof isNextExpanded === 'function'
                    ? isNextExpanded(paths.has(path))
                    : isNextExpanded;
            if (isExpanded) paths.add(path);
            else paths.delete(path);
            return { ...current, [scopeId]: [...paths] };
        });
    };
    const isRootClipboardEmpty = !clipboard || clipboard.projectId !== projectId;
    const isRootPasteBlocked = isPathBlockedByFileOperations(
        projectOperations,
        projectId,
        session.rootPath,
    );
    const isRootPasteDisabled = isRootClipboardEmpty || isRootPasteBlocked;
    const pasteIntoProjectRoot = async (): Promise<void> => {
        const currentClipboard = useFileClipboardStore.getState().entry;
        if (!currentClipboard) return;
        const pasted = await pasteFile(session.id, projectId, session.rootPath, currentClipboard);
        if (pasted) setSelectedPath(pasted.path);
    };
    const dropIntoProjectRoot = async (event: DragEvent): Promise<void> => {
        event.preventDefault();
        if (isRootPasteBlocked) return;
        const source = dragPath(event);
        if (!source) return;
        const moved = await moveFile(session.id, source, session.rootPath);
        if (moved) setSelectedPath(moved.path);
    };

    const tree = (
        <div
            role="tree"
            aria-label="Files"
            className="min-h-0 flex-1 overflow-auto"
            onDragOver={(event) => {
                if (!isRootPasteBlocked && hasDraggedPath(event)) event.preventDefault();
            }}
            onDrop={(event) => discard(dropIntoProjectRoot(event))}
        >
            <DirectoryEntries
                clearFocusPath={clearFocusPath}
                key={`${scopeId}:${collapseRevision}`}
                directory={session.rootPath}
                editing={editing}
                expandedPaths={expandedPaths}
                operations={projectOperations}
                focusPath={focusPath}
                projectId={projectId}
                projectRoot={session.rootPath}
                selectedPath={selectedPath}
                sessionId={session.id}
                requestFocus={requestFocus}
                setEditing={setEditing}
                setPathExpanded={setPathExpanded}
                setSelectedPath={setSelectedPath}
            />
        </div>
    );

    return (
        <div
            key={scopeId}
            aria-busy={Boolean(pendingOperation)}
            className="inspector-content flex min-h-0 flex-1 flex-col overflow-hidden"
        >
            <div
                ref={fileCaptionReference}
                className="panel-caption group/file-caption flex min-h-[34px] items-center justify-between gap-1 border-b border-border pt-[3px] pr-1 pb-[3px] pl-2 text-[11px] text-muted"
            >
                <span className="truncate" title={session.rootPath}>
                    {project?.displayTitle ?? session.rootPath.split('/').findLast(Boolean) ?? ''}
                </span>
                <span className="flex items-center gap-0.5">
                    <Tooltip content="New File">
                        <Button
                            className={captionActionClassName}
                            size="icon"
                            variant="ghost"
                            aria-label="New File"
                            onClick={() =>
                                setEditing({
                                    kind: 'create',
                                    directory: session.rootPath,
                                    itemKind: 'file',
                                    returnFocus: { kind: 'caption', itemKind: 'file' },
                                })
                            }
                        >
                            <FilePlus size={13} />
                        </Button>
                    </Tooltip>
                    <Tooltip content="New Folder">
                        <Button
                            className={captionActionClassName}
                            size="icon"
                            variant="ghost"
                            aria-label="New Folder"
                            onClick={() =>
                                setEditing({
                                    kind: 'create',
                                    directory: session.rootPath,
                                    itemKind: 'directory',
                                    returnFocus: { kind: 'caption', itemKind: 'directory' },
                                })
                            }
                        >
                            <FolderPlus size={13} />
                        </Button>
                    </Tooltip>
                    <CommandTooltip commandId="inspector.searchFiles">
                        <Button
                            className={cn(
                                isSearchVisible
                                    ? 'pointer-events-auto shrink-0 bg-elevated text-foreground opacity-100'
                                    : captionActionClassName,
                            )}
                            size="icon"
                            variant="ghost"
                            aria-label="Search Files"
                            aria-pressed={isSearchVisible}
                            onClick={() => {
                                if (isSearchVisible) closeFileSearch(session.id);
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
                            onClick={() => {
                                if (scopeId)
                                    setExpandedByScope((current) => ({
                                        ...current,
                                        [scopeId]: [],
                                    }));
                                setCollapseRevision((value) => value + 1);
                            }}
                        >
                            <SquareMinus size={13} />
                        </Button>
                    </Tooltip>
                </span>
            </div>
            {pendingOperation && (
                <div
                    role="status"
                    aria-live="polite"
                    className="flex items-center justify-between gap-2 border-b border-border bg-surface px-2 py-1 text-[11px] text-muted"
                >
                    <span className="truncate">{pendingOperation.label}</span>
                    {isCancelRevealed && (
                        <button
                            className="shrink-0 text-foreground underline decoration-dotted underline-offset-2 hover:text-accent"
                            type="button"
                            onClick={() => discard(cancelFileOperation(pendingOperation.id))}
                        >
                            Cancel
                        </button>
                    )}
                </div>
            )}
            {isSearchVisible ? (
                <ProjectSearch
                    key={scopeId}
                    focusRevision={searchFocusRevision}
                    sessionId={session.id}
                />
            ) : (
                <ContextMenu>
                    <ContextMenuTrigger render={tree} />
                    <ContextMenuContent>
                        <ContextMenuItem
                            onClick={() =>
                                setEditing({
                                    kind: 'create',
                                    directory: session.rootPath,
                                    itemKind: 'file',
                                    returnFocus: { kind: 'caption', itemKind: 'file' },
                                })
                            }
                        >
                            New File
                        </ContextMenuItem>
                        <ContextMenuItem
                            onClick={() =>
                                setEditing({
                                    kind: 'create',
                                    directory: session.rootPath,
                                    itemKind: 'directory',
                                    returnFocus: { kind: 'caption', itemKind: 'directory' },
                                })
                            }
                        >
                            New Folder
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem
                            disabled={isRootPasteDisabled}
                            disabledReason={
                                isRootClipboardEmpty
                                    ? 'Nothing to paste'
                                    : isRootPasteBlocked
                                      ? BUSY_DISABLED_REASON
                                      : undefined
                            }
                            hint={isRootPasteDisabled ? undefined : 'cmd+v'}
                            onClick={() => discard(pasteIntoProjectRoot())}
                        >
                            Paste
                        </ContextMenuItem>
                    </ContextMenuContent>
                </ContextMenu>
            )}
            <FileConflictDialog />
        </div>
    );
}
