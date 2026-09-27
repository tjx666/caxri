import type { KeyboardEvent, MouseEvent, RefObject } from 'react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { ExtensionTreeViewState, TreeItemDto, ViewActionDescriptor } from '@caxri/protocol';
import { projectStatusErrorLogsSchema } from '@caxri/protocol';
import { useVirtualizer } from '@tanstack/react-virtual';

import { executeCommand } from '../../commands/execute';
import { useScrollEdge } from '../../hooks/use-scroll-edge';
import { openExternalUrl } from '../../lib/external-link';
import { cn } from '../../lib/utilities';
import { useExtensionTreeViewState, useSessionViewScope } from '../../stores/selectors';
import { pushToast, tryCommand } from '../../stores/toasts';
import { useLogPrefillStore } from '../panel/views/logs/log-prefill';
import { cancelTreeChildrenRequest, ROOT_HANDLE } from './extension-tree-client';
import { ExtensionTreeHeader } from './extension-tree-header';
import type { ExtensionTreeNavigationKey } from './extension-tree-navigation';
import {
    extensionTreeHorizontalIntent,
    isNavigableExtensionTreeRow,
    nextExtensionTreeRowIndex,
} from './extension-tree-navigation';
import { ExtensionTreePlaceholderRow } from './extension-tree-placeholder-row';
import type { PendingTreeRefresh } from './extension-tree-refresh-state';
import {
    isMessageRefreshAction,
    reconcilePendingTreeRefresh,
} from './extension-tree-refresh-state';
import { ExtensionTreeRowContent, ExtensionTreeRowTooltip } from './extension-tree-row-content';
import type { VisibleItemRow, VisibleRow } from './extension-tree-rows';
import { flattenVisibleRows, visibleRowKey } from './extension-tree-rows';
import type { TreeRowAction } from './extension-tree-state';
import {
    focusTreeItem,
    isTreeItemExpanded,
    isTreeItemFocused,
    keyboardTreeRowAction,
    pointerTreeRowAction,
    toggleTreeItem,
    toggleTreeItemSubtree,
    treeItemSubtreeHandles,
} from './extension-tree-state';
import { useExtensionTreeChildren } from './hooks/use-extension-tree-children';
import { useExtensionTreeState } from './hooks/use-extension-tree-state';
import { dispatchExtensionViewAction } from './view-container-commands';

/**
 * Message guidance may wrap beyond the initial Empty layout, so its virtual row is measured after render.
 */
const MESSAGE_ROW_HEIGHT = 160;

function runTreeCommand(item: TreeItemDto): void {
    const command = item.command;
    if (!command) return;
    if (command.id === 'caxri.showLogs') {
        // Parsed rather than asserted: a tree item's arguments are `unknown[]` on the wire, and an extension that
        // sends a malformed query should open an unfiltered panel instead of one filtered to nothing.
        const prefill = projectStatusErrorLogsSchema.safeParse(command.arguments?.[0]);
        if (prefill.success) useLogPrefillStore.getState().requestLogPrefill(prefill.data);
        executeCommand('panel.showLogs');
        return;
    }
    if (command.id === 'caxri.openExternal') {
        // Fire-and-forget: tryCommand() reports command failures through the shared toast path.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void tryCommand(`Unable to run ${command.title}`, async () => {
            const [url] = command.arguments ?? [];
            if (typeof url !== 'string') throw new Error('External command requires a URL');
            await openExternalUrl(url, (message) => pushToast('error', message));
        });
        return;
    }
    // eslint-disable-next-line no-void -- the shared dispatcher reports failures through the same toast path
    void dispatchExtensionViewAction(command.id, command.title, command.arguments ?? []);
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

export function ExtensionTreeView({
    actions,
    extensionGeneration,
    title,
    viewId,
}: {
    actions?: readonly ViewActionDescriptor[];
    extensionGeneration: number;
    title: string;
    viewId: string;
}) {
    const { sessionId, workbenchProjectId } = useSessionViewScope();
    const persisted = useExtensionTreeViewState(viewId);
    const scope = useMemo(
        () =>
            sessionId && workbenchProjectId
                ? {
                      sessionId,
                      workbenchProjectId,
                      extensionGeneration,
                      viewId,
                  }
                : undefined,
        [extensionGeneration, sessionId, viewId, workbenchProjectId],
    );
    const refreshAction = actions?.find(({ role }) => role === 'resource.refresh');
    if (!scope)
        return (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <ExtensionTreeHeader
                    disabled
                    isRefreshing={false}
                    title={title}
                    onRefresh={refreshAction ? () => {} : undefined}
                />
                <div className="flex min-h-0 flex-1 items-center justify-center p-3 text-xs text-muted">
                    Select a Session to load this view.
                </div>
            </div>
        );
    return (
        <ExtensionTreeViewContent
            key={`${scope.sessionId}\0${scope.workbenchProjectId}\0${scope.extensionGeneration}\0${viewId}`}
            persisted={persisted}
            refreshAction={refreshAction}
            scope={scope}
            title={title}
        />
    );
}

/**
 * Every navigation key is resolved against the flat row list by `onNavigate`, which the tree owns: the row knows its
 * own index and nothing else, so it cannot see the status rows it has to step over or the child it has to step into.
 * That also keeps the whole row list out of the memoized row component's props.
 */
function handleTreeItemKeyDown(
    event: KeyboardEvent<HTMLDivElement>,
    {
        dispatchRowAction,
        index,
        onNavigate,
        row,
    }: {
        dispatchRowAction: (action: TreeRowAction) => void;
        index: number;
        onNavigate: (key: ExtensionTreeNavigationKey, index: number) => void;
        row: VisibleItemRow;
    },
): void {
    if (event.nativeEvent.isComposing) return;
    switch (event.key) {
        case 'ArrowDown':
        case 'ArrowUp':
        case 'ArrowLeft':
        case 'ArrowRight':
        case 'Home':
        case 'End':
            onNavigate(event.key, index);
            break;
        case 'Enter':
        case ' ':
            dispatchRowAction(keyboardTreeRowAction(row.item, event.key));
            break;
        default:
            return;
    }
    event.preventDefault();
}

function treeItemPresentation(row: VisibleItemRow, isRefreshing: boolean) {
    const isHeader = row.item.variant === 'header';
    const isMessage = row.item.variant === 'message';
    const isRefreshingMessage = isMessage && isRefreshing;
    return {
        className: cn(
            // Hover and keyboard focus only: this tree has no persistent selected row, so it must not borrow a
            // selection color to stand in for one. Keyboard focus adds the accent inset ring the Files and Source
            // Control trees already draw, because the focus fill alone is a wash the pointer can paint too.
            'flex w-full min-w-0 items-center gap-2 border-0 bg-transparent text-left text-foreground focus-visible:bg-list-focus-background focus-visible:text-list-focus-foreground focus-visible:shadow-[inset_0_0_0_2px_var(--accent)] focus-visible:outline-none',
            isHeader ? 'h-8 border-b border-border font-semibold' : isMessage ? 'min-h-40' : 'h-7',
            !isMessage
                ? 'pr-2 hover:bg-list-hover-background hover:text-list-hover-foreground'
                : undefined,
            !isMessage && row.item.command ? 'cursor-pointer' : undefined,
        ),
        commandTarget: !isRefreshingMessage && row.item.command ? 'true' : undefined,
        isCollapsible: row.item.collapsibleState !== 'none',
        isMessage,
        isRefreshingMessage,
        style: isMessage ? undefined : { paddingLeft: `${8 + row.depth * 14}px` },
        tooltip:
            row.item.tooltip ??
            (row.item.description ? `${row.item.label} — ${row.item.description}` : row.item.label),
    };
}

function dispatchTreeRowAction({
    action,
    isRefreshingMessage,
    onAction,
    row,
}: {
    action: TreeRowAction;
    isRefreshingMessage: boolean;
    onAction: (row: VisibleItemRow, action: TreeRowAction) => void;
    row: VisibleItemRow;
}): void {
    if (isRefreshingMessage && action === 'activate') return;
    onAction(row, action);
}

function handleTreeItemClick(
    event: MouseEvent<HTMLDivElement>,
    rowElement: RefObject<HTMLDivElement | null>,
    row: VisibleItemRow,
    dispatchRowAction: (action: TreeRowAction) => void,
): void {
    rowElement.current?.focus();
    if (row.item.variant === 'message') return;
    dispatchRowAction(pointerTreeRowAction(row.item, 'body', 'click', event.detail, event.altKey));
}

/**
 * Keeps one roving treeitem focus target while giving the disclosure its own pointer and accessible hit area. The
 * disclosure stays outside the tab order because Enter activates the row and Space expands it; pointer activation
 * restores focus to the treeitem before changing expansion.
 */
const TreeItemRow = memo(
    ({
        active,
        index,
        isRefreshing,
        onAction,
        onNavigate,
        onFocus,
        row,
    }: {
        active: boolean;
        index: number;
        /**
         * Only message rows react to a root refresh; item rows receive `false` so a refresh does not re-render them.
         */
        isRefreshing: boolean;
        onAction: (row: VisibleItemRow, action: TreeRowAction) => void;
        onNavigate: (key: ExtensionTreeNavigationKey, index: number) => void;
        onFocus: (row: VisibleItemRow) => void;
        row: VisibleItemRow;
    }) => {
        const { isExpanded, positionInSet, setSize } = row;
        const rowElement = useRef<HTMLDivElement>(null);
        const presentation = treeItemPresentation(row, isRefreshing);
        const dispatchRowAction = (action: TreeRowAction): void =>
            dispatchTreeRowAction({
                action,
                isRefreshingMessage: presentation.isRefreshingMessage,
                onAction,
                row,
            });
        const treeItem = (
            <div
                aria-busy={presentation.isRefreshingMessage || undefined}
                aria-disabled={presentation.isRefreshingMessage || undefined}
                aria-expanded={presentation.isCollapsible ? isExpanded : undefined}
                aria-label={row.item.accessibilityLabel}
                aria-level={row.depth + 1}
                aria-posinset={positionInSet}
                aria-selected={active}
                aria-setsize={setSize}
                className={presentation.className}
                data-tree-command-target={presentation.commandTarget}
                data-tree-index={index}
                data-tree-item-variant={row.item.variant}
                ref={rowElement}
                role="treeitem"
                style={presentation.style}
                tabIndex={active ? 0 : -1}
                onClick={(event) => handleTreeItemClick(event, rowElement, row, dispatchRowAction)}
                onFocus={() => onFocus(row)}
                onKeyDown={(event) =>
                    handleTreeItemKeyDown(event, {
                        dispatchRowAction,
                        index,
                        onNavigate,
                        row,
                    })
                }
            >
                <ExtensionTreeRowContent
                    dispatchRowAction={dispatchRowAction}
                    isRefreshing={isRefreshing}
                    row={row}
                    rowElement={rowElement}
                />
            </div>
        );
        return (
            <ExtensionTreeRowTooltip
                isMessage={presentation.isMessage}
                tooltip={presentation.tooltip}
                trigger={treeItem}
            />
        );
    },
);

interface TreeRowHandlers {
    onNavigate: (key: ExtensionTreeNavigationKey, index: number) => void;
    onRowAction: (row: VisibleItemRow, action: TreeRowAction) => void;
    onRowFocus: (row: VisibleItemRow) => void;
}

/**
 * Hands rows callbacks with a stable identity that read the latest handlers through a ref. Together with the memoized
 * `TreeItemRow` and the reused row objects, a focus change, refresh spinner, or toggle re-renders only the rows whose
 * own props changed instead of every visible row. The ref is synced in a layout effect, which runs before any user
 * event can reach a row. Kept as manual memoization because the tree content component is skipped by React Compiler.
 */
function useStableTreeRowHandlers(handlers: TreeRowHandlers): TreeRowHandlers {
    const latest = useRef<TreeRowHandlers>(undefined);
    useLayoutEffect(() => {
        latest.current = handlers;
    });
    const onNavigate = useCallback(
        (key: ExtensionTreeNavigationKey, index: number) => latest.current?.onNavigate(key, index),
        [],
    );
    const onRowAction = useCallback(
        (row: VisibleItemRow, action: TreeRowAction) => latest.current?.onRowAction(row, action),
        [],
    );
    const onRowFocus = useCallback((row: VisibleItemRow) => latest.current?.onRowFocus(row), []);
    return { onNavigate, onRowAction, onRowFocus };
}

function ExtensionTreeViewContent({
    persisted,
    refreshAction,
    scope,
    title,
}: {
    persisted?: ExtensionTreeViewState;
    refreshAction?: ViewActionDescriptor;
    scope: {
        sessionId: string;
        workbenchProjectId: string;
        extensionGeneration: number;
        viewId: string;
    };
    title: string;
}) {
    const scrollElement = useRef<HTMLDivElement>(null);
    useScrollEdge(scrollElement);
    const [treeState, updateTreeState] = useExtensionTreeState(scope, persisted);
    const {
        children,
        errors,
        loading,
        loadChildren,
        requests,
        rootLoads,
        visibleChildren,
        visibleErrors,
        visibleLoading,
    } = useExtensionTreeChildren(scope, updateTreeState, treeState);
    const refreshLock = useRef<string | undefined>(undefined);
    const [pendingRefresh, setPendingRefresh] = useState<PendingTreeRefresh>();
    const activePendingRefresh = pendingRefresh
        ? reconcilePendingTreeRefresh(pendingRefresh, rootLoads)
        : undefined;

    useEffect(() => {
        if (!activePendingRefresh) refreshLock.current = undefined;
    }, [activePendingRefresh]);

    const refresh = (): void => {
        if (!refreshAction || activePendingRefresh || refreshLock.current) return;
        const id = crypto.randomUUID();
        refreshLock.current = id;
        setPendingRefresh({ afterRootLoad: rootLoads.started, id });
        // eslint-disable-next-line no-void -- the header remains busy until the provider's resulting root load completes
        void dispatchExtensionViewAction(refreshAction.commandId, `Refresh ${title}`).then(
            (result) => {
                if (result === 'executed') return;
                if (refreshLock.current === id) refreshLock.current = undefined;
                setPendingRefresh((current) => (current?.id === id ? undefined : current));
            },
        );
    };

    // React Compiler skips this component (see the virtualizer note below), so row identity is preserved by hand:
    // the last committed flat list is threaded back in so unchanged rows keep their object and their rendered subtree.
    // The ref is written in a layout effect, so a discarded concurrent render never seeds the next reuse pass.
    const previousRows = useRef<readonly VisibleRow[]>([]);
    const rows = useMemo(
        () =>
            flattenVisibleRows({
                children: visibleChildren,
                errors: visibleErrors,
                isExpanded: (item) => isTreeItemExpanded(treeState, item),
                loading: visibleLoading,
                previous: previousRows.current,
                rootHandle: ROOT_HANDLE,
            }),
        [visibleChildren, visibleErrors, visibleLoading, treeState],
    );
    useLayoutEffect(() => {
        previousRows.current = rows;
    }, [rows]);
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
    }, [children, errors, loadChildren, loading, requests, treeState]);

    // TanStack Virtual is knowingly incompatible with React Compiler memoization; the compiler
    // skips this component, which is the library's documented, expected behavior.
    // eslint-disable-next-line react-hooks/incompatible-library -- see above
    const virtualizer = useVirtualizer({
        count: rows.length,
        estimateSize: (index) => {
            const row = rows[index];
            if (row.kind !== 'item') return 28;
            if (row.item.variant === 'message') return MESSAGE_ROW_HEIGHT;
            return row.item.variant === 'header' ? 32 : 28;
        },
        getItemKey: (index) => visibleRowKey(rows[index]),
        getScrollElement: () => scrollElement.current,
        overscan: 10,
    });
    const focusedRowIndex = rows.findIndex(
        (row) => row.kind === 'item' && isTreeItemFocused(treeState, row.item),
    );
    const firstItemIndex = rows.findIndex((row) => row.kind === 'item');
    const focusIndex = (index: number): void => {
        const row = rows.at(index);
        if (!isNavigableExtensionTreeRow(row)) return;
        updateTreeState((current) => focusTreeItem(current, row.item));
        virtualizer.scrollToIndex(index);
        requestAnimationFrame(() =>
            scrollElement.current
                ?.querySelector<HTMLElement>(`[data-tree-index="${CSS.escape(String(index))}"]`)
                ?.focus(),
        );
    };
    const toggle = (row: VisibleItemRow, isRecursive = false): void => {
        if (row.item.collapsibleState === 'none') {
            runTreeCommand(row.item);
            return;
        }
        const willExpand = !isTreeItemExpanded(treeState, row.item);
        updateTreeState((current) =>
            isRecursive
                ? toggleTreeItemSubtree(current, row.item, children)
                : toggleTreeItem(current, row.item),
        );
        if (willExpand && !children.has(row.item.handle)) {
            // eslint-disable-next-line no-void -- the loader reports failures in the tree's error row
            void loadChildren(row.item.handle);
        }
        if (!willExpand) {
            const handles = isRecursive
                ? treeItemSubtreeHandles(row.item, children)
                : [row.item.handle];
            for (const handle of handles) {
                const requestId = requests.current.get(handle);
                if (requestId) cancelTreeChildrenRequest(requestId);
            }
        }
    };
    /**
     * Resolves one navigation key against the current flat row list. Up/Down/Home/End step over the loading, error, and
     * empty rows, which carry no focus target; Left/Right collapse, expand, climb to the parent, or enter the first
     * child.
     */
    const navigate = (key: ExtensionTreeNavigationKey, index: number): void => {
        if (key === 'ArrowLeft' || key === 'ArrowRight') {
            const intent = extensionTreeHorizontalIntent(rows, index, key);
            const row = rows.at(index);
            if (intent.toggle && isNavigableExtensionTreeRow(row)) toggle(row);
            else if (intent.focusIndex !== undefined) focusIndex(intent.focusIndex);
            return;
        }
        const nextIndex = nextExtensionTreeRowIndex(rows, index, key);
        if (nextIndex !== undefined) focusIndex(nextIndex);
    };

    /**
     * `visibleLoading` — not the raw `loading` — is what decides whether the header spins: it drops any handle the
     * on-screen snapshot can already answer. Reading `loading` instead made every root revalidation announce itself,
     * including the one a Session switch triggers on remount, so returning to a Session the user had just left looked
     * like the panel was refetching when the rows never changed. A cold load has no snapshot, so it still spins, and a
     * manual refresh spins through `activePendingRefresh` regardless.
     */
    const isRootRefreshing = Boolean(activePendingRefresh) || visibleLoading.has(ROOT_HANDLE);
    const rowHandlers = useStableTreeRowHandlers({
        onNavigate: navigate,
        onRowAction: (row, action) => {
            switch (action) {
                case 'toggle': {
                    toggle(row);
                    break;
                }
                case 'toggle-recursive': {
                    toggle(row, true);
                    break;
                }
                case 'activate': {
                    if (isMessageRefreshAction(row.item, refreshAction)) refresh();
                    else runTreeCommand(row.item);
                    break;
                }
                // No default
            }
        },
        onRowFocus: (row) => updateTreeState((current) => focusTreeItem(current, row.item)),
    });

    return (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <ExtensionTreeHeader
                isRefreshing={isRootRefreshing}
                title={title}
                onRefresh={refreshAction ? refresh : undefined}
            />
            <div className="scroll-edge-shell relative flex min-h-0 flex-1 flex-col">
                <div
                    ref={scrollElement}
                    className="min-h-0 flex-1 overflow-auto"
                    data-scrolled="false"
                >
                    <ul
                        aria-label={title}
                        className="relative"
                        role="tree"
                        style={{ height: `${virtualizer.getTotalSize()}px` }}
                    >
                        {virtualizer.getVirtualItems().map((virtualRow) => {
                            const row = rows[virtualRow.index];
                            /*
                             * A real row puts `treeitem` on its own focusable element inside, so this wrapper steps out of
                             * the accessibility tree. A placeholder has no such element, and `role="none"` would then hoist
                             * its `status` div to be a direct child of `role="tree"`, which ARIA does not allow — a tree
                             * owns `treeitem` and `group`, nothing else. So the wrapper becomes the row instead: disabled,
                             * never focusable, with `isNavigableExtensionTreeRow` keeping arrow keys stepping over it.
                             */
                            const isPlaceholderRow = row.kind !== 'item';
                            return (
                                <li
                                    key={visibleRowKey(row)}
                                    aria-disabled={isPlaceholderRow || undefined}
                                    aria-level={isPlaceholderRow ? row.depth + 1 : undefined}
                                    className="absolute top-0 left-0 w-full"
                                    data-index={
                                        row.kind === 'item' && row.item.variant === 'message'
                                            ? virtualRow.index
                                            : undefined
                                    }
                                    ref={
                                        row.kind === 'item' && row.item.variant === 'message'
                                            ? virtualizer.measureElement
                                            : undefined
                                    }
                                    role={isPlaceholderRow ? 'treeitem' : 'none'}
                                    style={{ transform: `translateY(${virtualRow.start}px)` }}
                                >
                                    {isPlaceholderRow ? (
                                        <ExtensionTreePlaceholderRow
                                            row={row}
                                            onRetry={() => {
                                                // eslint-disable-next-line no-void -- the loader reports failures in the tree's error row
                                                void loadChildren(row.parentHandle);
                                            }}
                                        />
                                    ) : (
                                        <TreeItemRow
                                            active={
                                                focusedRowIndex === -1
                                                    ? virtualRow.index === firstItemIndex
                                                    : isTreeItemFocused(treeState, row.item)
                                            }
                                            index={virtualRow.index}
                                            isRefreshing={
                                                row.item.variant === 'message' && isRootRefreshing
                                            }
                                            row={row}
                                            onAction={rowHandlers.onRowAction}
                                            onFocus={rowHandlers.onRowFocus}
                                            onNavigate={rowHandlers.onNavigate}
                                        />
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                </div>
            </div>
        </div>
    );
}
