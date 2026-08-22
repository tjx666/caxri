import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ExtensionTreeViewState, TreeItemDto } from '@shared/views';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
    AlertTriangle,
    Check,
    ChevronDown,
    ChevronRight,
    Circle,
    CircleCheck,
    CircleDot,
    CircleX,
    Cloud,
    EyeOff,
    File,
    GitBranch,
    GitPullRequest,
    LoaderCircle,
    MessageSquareWarning,
    Monitor,
    Package,
    Rocket,
} from 'lucide-react';

import { executeCommand } from '../../commands/execute';
import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';
import { caxri } from '../../lib/caxri';
import { useSessionState } from '../../stores/selectors';
import { tryCommand } from '../../stores/toasts';
import type { TreeRowAction } from './extension-tree-state';
import {
    focusTreeItem,
    isTreeItemExpanded,
    isTreeItemFocused,
    keyboardTreeRowAction,
    pointerTreeRowAction,
    reconcileTreeItems,
    replaceTreeChildren,
    toggleTreeItem,
} from './extension-tree-state';
import { useExtensionTreeState } from './use-extension-tree-state';

const ROOT_HANDLE = '__caxri_tree_root__';
const themeIcons = {
    'check': Check,
    'circle-check': CircleCheck,
    'circle-dot': CircleDot,
    'circle-outline': Circle,
    'circle-x': CircleX,
    'cloud': Cloud,
    'error': AlertTriangle,
    'eye-off': EyeOff,
    'file': File,
    'folder': Package,
    'git-branch': GitBranch,
    'git-pull-request': GitPullRequest,
    'issues': MessageSquareWarning,
    'loading': LoaderCircle,
    'monitor': Monitor,
    'package': Package,
    'pass': Check,
    'question': Circle,
    'repo': Package,
    'rocket': Rocket,
    'symbol-string': File,
    'warning': AlertTriangle,
} as const;
const themeIconClassNames: Partial<Record<keyof typeof themeIcons, string>> = {
    'check': 'text-success',
    'circle-check': 'text-success',
    'circle-dot': 'text-muted',
    'circle-outline': 'text-muted',
    'circle-x': 'text-danger',
    'error': 'text-danger',
    'loading': 'animate-spin text-warning',
    'pass': 'text-success',
    'question': 'text-muted',
    'warning': 'text-warning',
};

interface VisibleItemRow {
    kind: 'item';
    depth: number;
    item: TreeItemDto;
    parentHandle: string;
}

interface VisibleLoadingRow {
    kind: 'loading';
    depth: number;
    parentHandle: string;
}

interface VisibleErrorRow {
    kind: 'error';
    depth: number;
    message: string;
    parentHandle: string;
}

interface VisibleEmptyRow {
    kind: 'empty';
    depth: number;
    parentHandle: string;
}

type VisibleRow = VisibleItemRow | VisibleLoadingRow | VisibleErrorRow | VisibleEmptyRow;

function runTreeCommand(item: TreeItemDto): void {
    const command = item.command;
    if (!command) return;
    // Fire-and-forget: tryCommand() reports command failures through the shared toast path.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void tryCommand(`Unable to run ${command.title}`, async () => {
        if (command.id === 'caxri.openExternal') {
            const [url] = command.arguments ?? [];
            if (typeof url !== 'string') throw new Error('External command requires a URL');
            await caxri.request('external.open', { url });
            return;
        }
        if (command.id === 'caxri.showLogs') {
            executeCommand('panel.showLogs');
            return;
        }
        await caxri.request('viewContainers.executeCommand', {
            commandId: command.id,
            arguments: command.arguments ? [...command.arguments] : [],
        });
    });
}

function flattenRows(
    children: ReadonlyMap<string, readonly TreeItemDto[]>,
    errors: ReadonlyMap<string, string>,
    isExpanded: (item: TreeItemDto) => boolean,
    loading: ReadonlySet<string>,
): VisibleRow[] {
    const rows: VisibleRow[] = [];
    const append = (parentHandle: string, depth: number): void => {
        if (loading.has(parentHandle)) {
            rows.push({ kind: 'loading', depth, parentHandle });
            return;
        }
        const error = errors.get(parentHandle);
        if (error) {
            rows.push({ kind: 'error', depth, parentHandle, message: error });
            return;
        }
        const items = children.get(parentHandle) ?? [];
        if (children.has(parentHandle) && items.length === 0) {
            rows.push({ kind: 'empty', depth, parentHandle });
            return;
        }
        for (const item of items) {
            rows.push({ kind: 'item', depth, item, parentHandle });
            if (isExpanded(item)) append(item.handle, depth + 1);
        }
    };
    append(ROOT_HANDLE, 0);
    return rows;
}

function unloadedExpandedHandles(
    children: ReadonlyMap<string, readonly TreeItemDto[]>,
    errors: ReadonlyMap<string, string>,
    loading: ReadonlySet<string>,
    activeRequests: ReadonlyMap<string, string>,
    isExpanded: (item: TreeItemDto) => boolean,
): string[] {
    const handles: string[] = [];
    for (const items of children.values())
        for (const item of items)
            if (
                item.collapsibleState !== 'none' &&
                isExpanded(item) &&
                !children.has(item.handle) &&
                !errors.has(item.handle) &&
                !loading.has(item.handle) &&
                !activeRequests.has(item.handle)
            )
                handles.push(item.handle);
    return handles;
}

export function ExtensionTreeView({ viewId }: { viewId: string }) {
    const sessionState = useSessionState();
    const sessionId = sessionState?.sessionId;
    const workbenchProjectId = sessionState?.workbenchProjectId;
    const scope = useMemo(
        () =>
            sessionId && workbenchProjectId
                ? {
                      sessionId,
                      workbenchProjectId,
                      viewId,
                  }
                : undefined,
        [sessionId, viewId, workbenchProjectId],
    );
    if (!scope)
        return (
            <div className="flex min-h-0 flex-1 items-center justify-center p-3 text-xs text-muted">
                Select a Session to load this view.
            </div>
        );
    return (
        <ExtensionTreeViewContent
            key={`${scope.sessionId}\0${scope.workbenchProjectId}\0${viewId}`}
            persisted={sessionState?.extensionTreeViewStates?.[viewId]}
            scope={scope}
            viewId={viewId}
        />
    );
}

function ExtensionTreeViewContent({
    persisted,
    scope,
    viewId,
}: {
    persisted?: ExtensionTreeViewState;
    scope: { sessionId: string; workbenchProjectId: string; viewId: string };
    viewId: string;
}) {
    const scrollElement = useRef<HTMLDivElement>(null);
    const requests = useRef(new Map<string, string>());
    const childrenReference = useRef<ReadonlyMap<string, readonly TreeItemDto[]>>(new Map());
    const [children, setChildren] = useState<ReadonlyMap<string, readonly TreeItemDto[]>>(
        () => childrenReference.current,
    );
    const [errors, setErrors] = useState<ReadonlyMap<string, string>>(() => new Map());
    const [loading, setLoading] = useState<ReadonlySet<string>>(() => new Set([ROOT_HANDLE]));
    const [treeState, updateTreeState] = useExtensionTreeState(scope, persisted);

    const replaceLoadedChildren = useCallback(
        (parentHandle: string, items: readonly TreeItemDto[]): void => {
            const replacement = replaceTreeChildren(childrenReference.current, parentHandle, items);
            childrenReference.current = replacement.children;
            setChildren(replacement.children);
            if (replacement.retiredHandles.size === 0) return;

            for (const handle of replacement.retiredHandles) {
                const requestId = requests.current.get(handle);
                if (!requestId) continue;
                requests.current.delete(handle);
                // eslint-disable-next-line no-void -- refreshed descendants invalidate their in-flight requests
                void caxri.request('viewContainers.cancelRequest', { requestId });
            }
            setErrors((current) => {
                const next = new Map(current);
                for (const handle of replacement.retiredHandles) next.delete(handle);
                return next;
            });
            setLoading((current) => {
                const next = new Set(current);
                for (const handle of replacement.retiredHandles) next.delete(handle);
                return next;
            });
        },
        [],
    );

    const resetLoadedChildren = useCallback((): void => {
        for (const requestId of requests.current.values()) {
            // eslint-disable-next-line no-void -- a root refresh invalidates every in-flight branch request
            void caxri.request('viewContainers.cancelRequest', { requestId });
        }
        requests.current.clear();
        const empty = new Map<string, readonly TreeItemDto[]>();
        childrenReference.current = empty;
        setChildren(empty);
        setErrors(new Map());
        setLoading(new Set());
    }, []);

    const loadChildren = useCallback(
        async (parentHandle: string): Promise<void> => {
            const previousRequestId = requests.current.get(parentHandle);
            if (previousRequestId) {
                // eslint-disable-next-line no-void -- cancellation is best-effort and the next request owns loading state
                void caxri.request('viewContainers.cancelRequest', {
                    requestId: previousRequestId,
                });
            }
            const requestId = crypto.randomUUID();
            requests.current.set(parentHandle, requestId);
            setLoading((current) => new Set(current).add(parentHandle));
            setErrors((current) => {
                const next = new Map(current);
                next.delete(parentHandle);
                return next;
            });
            try {
                const result = await caxri.request('viewContainers.treeChildren', {
                    viewId,
                    requestId,
                    ...(parentHandle !== ROOT_HANDLE && { parentHandle }),
                });
                if (requests.current.get(parentHandle) !== requestId) return;
                if (result.reset) resetLoadedChildren();
                const resultParentHandle = result.reset ? ROOT_HANDLE : parentHandle;
                replaceLoadedChildren(resultParentHandle, result.items);
                updateTreeState((current) => {
                    let next = reconcileTreeItems(current, result.items);
                    if (resultParentHandle === ROOT_HANDLE && !next.focusedKey && result.items[0])
                        next = focusTreeItem(next, result.items[0]);
                    return next;
                });
            } catch (error) {
                if (requests.current.get(parentHandle) !== requestId) return;
                setErrors((current) =>
                    new Map(current).set(
                        parentHandle,
                        error instanceof Error ? error.message : String(error),
                    ),
                );
            } finally {
                if (requests.current.get(parentHandle) === requestId) {
                    requests.current.delete(parentHandle);
                    setLoading((current) => {
                        const next = new Set(current);
                        next.delete(parentHandle);
                        return next;
                    });
                }
            }
        },
        [replaceLoadedChildren, resetLoadedChildren, updateTreeState, viewId],
    );

    useEffect(() => {
        // eslint-disable-next-line no-void -- the loader reports failures in the tree's error row
        void loadChildren(ROOT_HANDLE);
        const unsubscribe = caxri.onEvent((event) => {
            if (event.event !== 'viewContainers.treeChanged' || event.payload.viewId !== viewId)
                return;
            if (!event.payload.handles) {
                resetLoadedChildren();
                // eslint-disable-next-line no-void -- the loader reports failures in the tree's error row
                void loadChildren(ROOT_HANDLE);
                return;
            }
            const handles = event.payload.handles;
            for (const handle of handles) {
                // eslint-disable-next-line no-void -- each changed branch reports failures in the tree's error row
                void loadChildren(handle);
            }
        });
        const activeRequests = requests.current;
        return () => {
            unsubscribe();
            for (const requestId of activeRequests.values()) {
                // eslint-disable-next-line no-void -- cancellation is best-effort during unmount
                void caxri.request('viewContainers.cancelRequest', { requestId });
            }
            activeRequests.clear();
        };
    }, [loadChildren, resetLoadedChildren, viewId]);

    const rows = useMemo(
        () => flattenRows(children, errors, (item) => isTreeItemExpanded(treeState, item), loading),
        [children, errors, loading, treeState],
    );
    useEffect(() => {
        const handles = unloadedExpandedHandles(
            children,
            errors,
            loading,
            requests.current,
            (item) => isTreeItemExpanded(treeState, item),
        );
        for (const handle of handles) {
            // eslint-disable-next-line no-void -- restored/provider expansion reports failures in its tree branch
            void loadChildren(handle);
        }
    }, [children, errors, loadChildren, loading, treeState]);
    const virtualizer = useVirtualizer({
        count: rows.length,
        estimateSize: () => 28,
        getScrollElement: () => scrollElement.current,
        overscan: 10,
    });
    const focusedRowIndex = rows.findIndex(
        (row) => row.kind === 'item' && isTreeItemFocused(treeState, row.item),
    );
    const firstItemIndex = rows.findIndex((row) => row.kind === 'item');
    const focusIndex = (index: number): void => {
        const boundedIndex = Math.max(0, Math.min(rows.length - 1, index));
        const row = rows.at(boundedIndex);
        if (row?.kind !== 'item') return;
        updateTreeState((current) => focusTreeItem(current, row.item));
        virtualizer.scrollToIndex(boundedIndex);
        requestAnimationFrame(() =>
            scrollElement.current
                ?.querySelector<HTMLElement>(
                    `[data-tree-index="${CSS.escape(String(boundedIndex))}"]`,
                )
                ?.focus(),
        );
    };
    const toggle = (row: VisibleItemRow): void => {
        if (row.item.collapsibleState === 'none') {
            runTreeCommand(row.item);
            return;
        }
        const willExpand = !isTreeItemExpanded(treeState, row.item);
        updateTreeState((current) => toggleTreeItem(current, row.item));
        if (willExpand && !children.has(row.item.handle)) {
            // eslint-disable-next-line no-void -- the loader reports failures in the tree's error row
            void loadChildren(row.item.handle);
        }
        if (!willExpand) {
            const requestId = requests.current.get(row.item.handle);
            if (requestId) {
                // eslint-disable-next-line no-void -- cancellation is best-effort when collapsing a branch
                void caxri.request('viewContainers.cancelRequest', { requestId });
            }
        }
    };

    return (
        <div ref={scrollElement} className="min-h-0 flex-1 overflow-auto">
            <ul
                aria-label="Extension View"
                className="relative"
                role="tree"
                style={{ height: `${virtualizer.getTotalSize()}px` }}
            >
                {virtualizer.getVirtualItems().map((virtualRow) => {
                    const row = rows[virtualRow.index];
                    return (
                        <li
                            key={
                                row.kind === 'item'
                                    ? row.item.handle
                                    : `${row.kind}:${row.parentHandle}`
                            }
                            className="absolute top-0 left-0 w-full"
                            role="none"
                            style={{ transform: `translateY(${virtualRow.start}px)` }}
                        >
                            {row.kind === 'loading' ? (
                                <div
                                    className="flex h-7 items-center gap-2 text-xs text-muted"
                                    style={{ paddingLeft: `${8 + row.depth * 14}px` }}
                                >
                                    <LoaderCircle className="animate-spin" size={14} /> Loading
                                    view…
                                </div>
                            ) : row.kind === 'error' ? (
                                <div
                                    className="flex h-7 items-center gap-2 text-xs text-danger"
                                    style={{ paddingLeft: `${8 + row.depth * 14}px` }}
                                >
                                    <AlertTriangle size={14} />
                                    <span className="min-w-0 flex-1 truncate">
                                        Unable to load view: {row.message}
                                    </span>
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        onClick={() => {
                                            // eslint-disable-next-line no-void -- the loader reports failures in the tree's error row
                                            void loadChildren(row.parentHandle);
                                        }}
                                    >
                                        Retry
                                    </Button>
                                </div>
                            ) : row.kind === 'empty' ? (
                                <div
                                    className="flex h-7 items-center text-xs text-muted"
                                    style={{ paddingLeft: `${8 + row.depth * 14}px` }}
                                >
                                    No items in this view.
                                </div>
                            ) : (
                                <TreeItemRow
                                    active={
                                        focusedRowIndex === -1
                                            ? virtualRow.index === firstItemIndex
                                            : isTreeItemFocused(treeState, row.item)
                                    }
                                    index={virtualRow.index}
                                    row={row}
                                    rows={rows}
                                    onAction={(action) => {
                                        if (action === 'toggle') toggle(row);
                                        else if (action === 'activate') runTreeCommand(row.item);
                                    }}
                                    onFocus={() =>
                                        updateTreeState((current) =>
                                            focusTreeItem(current, row.item),
                                        )
                                    }
                                    onFocusIndex={focusIndex}
                                />
                            )}
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}

function TreeItemRow({
    active,
    index,
    onAction,
    onFocusIndex,
    onFocus,
    row,
    rows,
}: {
    active: boolean;
    index: number;
    onAction: (action: TreeRowAction) => void;
    onFocusIndex: (index: number) => void;
    onFocus: () => void;
    row: VisibleItemRow;
    rows: readonly VisibleRow[];
}) {
    const isCollapsible = row.item.collapsibleState !== 'none';
    const nextRow = rows.at(index + 1);
    const isExpanded = nextRow !== undefined && nextRow.depth > row.depth;
    const siblings = rows.filter(
        (candidate): candidate is VisibleItemRow =>
            candidate.kind === 'item' && candidate.parentHandle === row.parentHandle,
    );
    const positionInSet = siblings.findIndex(({ item }) => item.handle === row.item.handle) + 1;
    const themeIconId = row.item.icon?.kind === 'theme' ? row.item.icon.id : undefined;
    const Icon =
        themeIconId !== undefined && themeIconId in themeIcons
            ? themeIcons[themeIconId as keyof typeof themeIcons]
            : File;
    const tooltip =
        row.item.tooltip ??
        (row.item.description ? `${row.item.label} — ${row.item.description}` : row.item.label);
    const treeItem = (
        <button
            aria-expanded={isCollapsible ? isExpanded : undefined}
            aria-label={row.item.accessibilityLabel}
            aria-level={row.depth + 1}
            aria-posinset={positionInSet}
            aria-selected={active}
            aria-setsize={siblings.length}
            className="flex h-7 w-full min-w-0 items-center gap-1 border-0 bg-transparent pr-2 text-left text-xs text-foreground hover:bg-elevated focus-visible:bg-elevated focus-visible:outline-none"
            data-tree-index={index}
            role="treeitem"
            style={{ paddingLeft: `${8 + row.depth * 14}px` }}
            tabIndex={active ? 0 : -1}
            onClick={(event) => onAction(pointerTreeRowAction(row.item, 'click', event.detail))}
            onDoubleClick={(event) =>
                onAction(pointerTreeRowAction(row.item, 'doubleClick', event.detail))
            }
            onFocus={onFocus}
            onKeyDown={(event) => {
                switch (event.key) {
                    case 'ArrowDown':
                        onFocusIndex(index + 1);
                        break;
                    case 'ArrowUp':
                        onFocusIndex(index - 1);
                        break;
                    case 'ArrowRight':
                        if (!isCollapsible || isExpanded) return;
                        onAction('toggle');
                        break;
                    case 'ArrowLeft':
                        if (isCollapsible && isExpanded) onAction('toggle');
                        else {
                            const parentIndex = rows.findLastIndex(
                                (candidate, candidateIndex) =>
                                    candidateIndex < index &&
                                    candidate.kind === 'item' &&
                                    candidate.depth === row.depth - 1,
                            );
                            if (parentIndex !== -1) onFocusIndex(parentIndex);
                        }
                        break;
                    case 'Enter':
                    case ' ':
                        onAction(keyboardTreeRowAction(row.item, event.key));
                        break;
                    case 'Home':
                        onFocusIndex(0);
                        break;
                    case 'End':
                        onFocusIndex(rows.length - 1);
                        break;
                    default:
                        return;
                }
                event.preventDefault();
            }}
        >
            {isCollapsible ? (
                isExpanded ? (
                    <ChevronDown size={13} />
                ) : (
                    <ChevronRight size={13} />
                )
            ) : (
                <span className="w-[13px]" />
            )}
            <Icon
                className={
                    themeIconId && themeIconId in themeIcons
                        ? themeIconClassNames[themeIconId as keyof typeof themeIcons]
                        : undefined
                }
                data-theme-icon={themeIconId}
                size={14}
            />
            <span className="min-w-0 flex-1 truncate">{row.item.label}</span>
            {row.item.description && (
                <span className="max-w-[45%] min-w-0 shrink truncate text-[11px] text-muted">
                    {row.item.description}
                </span>
            )}
        </button>
    );
    return <Tooltip content={tooltip}>{treeItem}</Tooltip>;
}
