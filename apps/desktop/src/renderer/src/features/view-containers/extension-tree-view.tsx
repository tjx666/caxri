import { useEffect, useMemo, useRef, useState } from 'react';

import type { ExtensionTreeViewState, TreeItemDto, ViewActionDescriptor } from '@caxri/protocol';
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
import { cn } from '../../lib/utilities';
import { useSessionState } from '../../stores/selectors';
import { tryCommand } from '../../stores/toasts';
import { ExtensionTreeHeader } from './extension-tree-header';
import type { PendingTreeRefresh } from './extension-tree-refresh-state';
import { reconcilePendingTreeRefresh } from './extension-tree-refresh-state';
import type { TreeRowAction } from './extension-tree-state';
import {
    focusTreeItem,
    isTreeItemExpanded,
    isTreeItemFocused,
    keyboardTreeRowAction,
    pointerTreeRowAction,
    toggleTreeItem,
} from './extension-tree-state';
import { ROOT_HANDLE, useExtensionTreeChildren } from './use-extension-tree-children';
import { useExtensionTreeState } from './use-extension-tree-state';
import { dispatchExtensionViewAction } from './view-container-commands';

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
    const sessionState = useSessionState();
    const sessionId = sessionState?.sessionId;
    const workbenchProjectId = sessionState?.workbenchProjectId;
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
            persisted={sessionState?.extensionTreeViewStates?.[viewId]}
            refreshAction={refreshAction}
            scope={scope}
            title={title}
        />
    );
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
    const [treeState, updateTreeState] = useExtensionTreeState(scope, persisted);
    const { children, errors, loading, loadChildren, requests, rootLoads } =
        useExtensionTreeChildren(scope, updateTreeState);
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
    }, [children, errors, loadChildren, loading, requests, treeState]);

    // TanStack Virtual is knowingly incompatible with React Compiler memoization; the compiler
    // skips this component, which is the library's documented, expected behavior.
    // eslint-disable-next-line react-hooks/incompatible-library -- see above
    const virtualizer = useVirtualizer({
        count: rows.length,
        estimateSize: (index) => {
            const row = rows[index];
            return row.kind === 'item' && row.item.variant === 'header' ? 32 : 28;
        },
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
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <ExtensionTreeHeader
                isRefreshing={Boolean(activePendingRefresh) || loading.has(ROOT_HANDLE)}
                title={title}
                onRefresh={refreshAction ? refresh : undefined}
            />
            <div ref={scrollElement} className="min-h-0 flex-1 overflow-auto">
                <ul
                    aria-label={title}
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
                                    // `role="treeitem"` (rather than the `li`'s own `role="none"`) keeps the placeholder
                                    // discoverable by the same tree/treeitem contract the interactive rows below use, so
                                    // screen reader users don't hit a silent gap while a branch is fetching.
                                    <div
                                        aria-label="Loading…"
                                        aria-level={row.depth + 1}
                                        className="flex h-7 items-center gap-2 text-muted"
                                        role="treeitem"
                                        style={{ paddingLeft: `${8 + row.depth * 14}px` }}
                                    >
                                        <LoaderCircle className="animate-spin" size={14} /> Loading
                                        view…
                                    </div>
                                ) : row.kind === 'error' ? (
                                    <div
                                        aria-label={`Unable to load view: ${row.message}`}
                                        aria-level={row.depth + 1}
                                        className="flex h-7 items-center gap-2 text-danger"
                                        role="treeitem"
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
                                        aria-label="No items in this view."
                                        aria-level={row.depth + 1}
                                        className="flex h-7 items-center text-muted"
                                        role="treeitem"
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
                                            else if (action === 'activate')
                                                runTreeCommand(row.item);
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
        </div>
    );
}

/**
 * Keeps one roving treeitem focus target while giving the disclosure its own pointer and accessible hit area. The
 * disclosure stays outside the tab order because Enter activates the row and Space expands it; pointer activation
 * restores focus to the treeitem before changing expansion.
 */
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
    const isHeader = row.item.variant === 'header';
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
    const rowElement = useRef<HTMLDivElement>(null);
    const tooltip =
        row.item.tooltip ??
        (row.item.description ? `${row.item.label} — ${row.item.description}` : row.item.label);
    const treeItem = (
        <div
            aria-expanded={isCollapsible ? isExpanded : undefined}
            aria-label={row.item.accessibilityLabel}
            aria-level={row.depth + 1}
            aria-posinset={positionInSet}
            aria-selected={active}
            aria-setsize={siblings.length}
            className={cn(
                'flex w-full min-w-0 items-center gap-2 border-0 bg-transparent pr-2 text-left text-foreground hover:bg-elevated focus-visible:bg-elevated focus-visible:outline-none',
                isHeader ? 'h-8 border-b border-border font-semibold' : 'h-7',
                row.item.command ? 'cursor-pointer' : undefined,
            )}
            data-tree-command-target={row.item.command ? 'true' : undefined}
            data-tree-index={index}
            data-tree-item-variant={row.item.variant}
            ref={rowElement}
            role="treeitem"
            style={{ paddingLeft: `${8 + row.depth * 14}px` }}
            tabIndex={active ? 0 : -1}
            onClick={(event) => {
                rowElement.current?.focus();
                onAction(pointerTreeRowAction(row.item, 'body', 'click', event.detail));
            }}
            onFocus={onFocus}
            onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
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
                <button
                    aria-expanded={isExpanded}
                    aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${row.item.accessibilityLabel}`}
                    className="-m-1 flex size-[21px] shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted hover:text-foreground"
                    data-tree-disclosure="true"
                    tabIndex={-1}
                    type="button"
                    onClick={(event) => {
                        event.stopPropagation();
                        rowElement.current?.focus();
                        onAction(
                            pointerTreeRowAction(row.item, 'disclosure', 'click', event.detail),
                        );
                    }}
                >
                    {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                </button>
            ) : (
                <span className="w-[13px] shrink-0" />
            )}
            <Icon
                className={cn(
                    'shrink-0',
                    themeIconId && themeIconId in themeIcons
                        ? themeIconClassNames[themeIconId as keyof typeof themeIcons]
                        : undefined,
                )}
                data-theme-icon={themeIconId}
                size={14}
            />
            <span className="min-w-0 flex-1 truncate">{row.item.label}</span>
            {row.item.description && (
                <span className="max-w-[45%] min-w-0 shrink truncate text-[11px] font-normal text-muted">
                    {row.item.description}
                </span>
            )}
        </div>
    );
    return (
        <Tooltip anchorMode="cursor" content={tooltip}>
            {treeItem}
        </Tooltip>
    );
}
