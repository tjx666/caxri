import { FilePlus, FolderPlus, Search, SquareMinus } from 'lucide-react';
import { useEffect, useRef, useState, type DragEvent } from 'react';

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
import { cn } from '../../../../lib/utils';
import { useSelectedSession, useSelectedWorkbenchProject } from '../../../../stores/selectors';
import { cancelFileOperation, moveFile, pasteFile } from './file-actions';
import { useFileClipboardStore } from './file-clipboard';
import { FileConflictDialog } from './FileConflictDialog';
import {
    CANCEL_REVEAL_THRESHOLD_MS,
    isPathBlockedByFileOperations,
    useFileOperationStore,
    type PendingFileOperation,
} from './file-operation-state';
import { dragPath, hasDraggedPath } from './file-tree-drag';
import {
    BUSY_DISABLED_REASON,
    DirectoryEntries,
    type EditRequest,
    type FocusTarget,
} from './file-tree-row';
import { ProjectSearch } from './ProjectSearch';
import { closeFileSearch, useFileSearchStore } from './file-search-state';

const captionActionClassName =
    'pointer-events-none shrink-0 opacity-0 transition-opacity group-hover/file-caption:pointer-events-auto group-hover/file-caption:opacity-100 group-focus-within/file-caption:pointer-events-auto group-focus-within/file-caption:opacity-100';

/**
 * A Cancel affordance would be noisy if it appeared for every fast operation, so it only reveals
 * once `pendingOperation` has been running past `CANCEL_REVEAL_THRESHOLD_MS`. `Date.now()` is
 * impure and React's render phase must stay pure, so every state update — including the
 * already-past-threshold case — goes through a `setTimeout` callback (0ms when the threshold has
 * already elapsed) instead of a synchronous `setState` call in the effect body. This mirrors
 * `useDebouncedValue` in `StatusBar.tsx`, which defers its own correction the same way.
 */
function useCancelRevealed(operation: PendingFileOperation | undefined): boolean {
    const [revealed, setRevealed] = useState(false);
    const cancelable = operation?.cancelable ?? false;
    const startedAt = operation?.startedAt;
    useEffect(() => {
        if (!cancelable || startedAt === undefined) {
            const timer = setTimeout(() => setRevealed(false), 0);
            return () => clearTimeout(timer);
        }
        const remaining = startedAt + CANCEL_REVEAL_THRESHOLD_MS - Date.now();
        const timer = setTimeout(() => setRevealed(true), Math.max(remaining, 0));
        return () => clearTimeout(timer);
    }, [cancelable, startedAt]);
    return revealed;
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
    const cancelRevealed = useCancelRevealed(pendingOperation);
    const fileCaptionRef = useRef<HTMLDivElement>(null);
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
        fileCaptionRef.current
            ?.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
            ?.focus();
    };
    const searchVisible = useFileSearchStore(
        (state) => Boolean(sessionId) && state.activeSessionId === sessionId,
    );
    const searchFocusRevision = useFileSearchStore((state) => state.focusRevision);
    if (!session)
        return (
            <div className="empty-panel py-4 px-3 text-muted text-center">
                Create a Session to browse files.
            </div>
        );
    const projectId = selectedProjectId ?? session.workbenchProjectId;
    const expandedPaths = new Set(scopeId ? (expandedByScope[scopeId] ?? []) : []);
    const setPathExpanded = (
        path: string,
        next: boolean | ((current: boolean) => boolean),
    ): void => {
        if (!scopeId) return;
        setExpandedByScope((current) => {
            const paths = new Set(current[scopeId] ?? []);
            const expanded = typeof next === 'function' ? next(paths.has(path)) : next;
            if (expanded) paths.add(path);
            else paths.delete(path);
            return { ...current, [scopeId]: [...paths] };
        });
    };
    const rootClipboardEmpty = !clipboard || clipboard.projectId !== projectId;
    const rootPasteBlocked = isPathBlockedByFileOperations(
        projectOperations,
        projectId,
        session.rootPath,
    );
    const rootPasteDisabled = rootClipboardEmpty || rootPasteBlocked;
    const pasteIntoProjectRoot = async (): Promise<void> => {
        const currentClipboard = useFileClipboardStore.getState().entry;
        if (!currentClipboard) return;
        const pasted = await pasteFile(session.id, projectId, session.rootPath, currentClipboard);
        if (pasted) setSelectedPath(pasted.path);
    };
    const dropIntoProjectRoot = async (event: DragEvent): Promise<void> => {
        event.preventDefault();
        if (rootPasteBlocked) return;
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
                if (!rootPasteBlocked && hasDraggedPath(event)) event.preventDefault();
            }}
            onDrop={(event) => void dropIntoProjectRoot(event)}
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
                ref={fileCaptionRef}
                className="panel-caption group/file-caption flex min-h-[34px] items-center justify-between gap-1 pt-[3px] pr-1 pb-[3px] pl-2 border-b border-border text-muted text-[11px]"
            >
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
                    {cancelRevealed && (
                        <button
                            className="shrink-0 text-foreground underline decoration-dotted underline-offset-2 hover:text-accent"
                            type="button"
                            onClick={() => void cancelFileOperation(pendingOperation.id)}
                        >
                            Cancel
                        </button>
                    )}
                </div>
            )}
            {searchVisible ? (
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
                            disabled={rootPasteDisabled}
                            disabledReason={
                                rootClipboardEmpty
                                    ? 'Nothing to paste'
                                    : rootPasteBlocked
                                      ? BUSY_DISABLED_REASON
                                      : undefined
                            }
                            hint={rootPasteDisabled ? undefined : 'cmd+v'}
                            onClick={() => void pasteIntoProjectRoot()}
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
