import type { MouseEvent } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { TreeItemDto } from '@shared/views';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { LucideIcon } from 'lucide-react';
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
import { caxri } from '../../lib/caxri';
import { cn } from '../../lib/utilities';
import { tryCommand } from '../../stores/toasts';

const ROOT_HANDLE = '__caxri_tree_root__';
const themeIcons: Record<string, { Icon: LucideIcon; className?: string }> = {
    'check': { Icon: Check },
    'circle-check': { Icon: CircleCheck, className: 'text-success' },
    'circle-dot': { Icon: CircleDot, className: 'text-muted' },
    'circle-outline': { Icon: Circle, className: 'text-muted' },
    'circle-x': { Icon: CircleX, className: 'text-danger' },
    'cloud': { Icon: Cloud },
    'error': { Icon: AlertTriangle, className: 'text-danger' },
    'eye-off': { Icon: EyeOff },
    'file': { Icon: File },
    'folder': { Icon: Package },
    'git-branch': { Icon: GitBranch },
    'git-pull-request': { Icon: GitPullRequest },
    'issues': { Icon: MessageSquareWarning },
    'loading': { Icon: LoaderCircle, className: 'animate-spin text-warning' },
    'monitor': { Icon: Monitor },
    'package': { Icon: Package },
    'pass': { Icon: Check, className: 'text-success' },
    'question': { Icon: Circle, className: 'text-muted' },
    'repo': { Icon: Package },
    'rocket': { Icon: Rocket },
    'symbol-string': { Icon: File },
    'warning': { Icon: AlertTriangle, className: 'text-danger' },
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

type VisibleRow = VisibleItemRow | VisibleLoadingRow | VisibleErrorRow;

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
    expanded: ReadonlySet<string>,
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
        for (const item of items) {
            rows.push({ kind: 'item', depth, item, parentHandle });
            if (expanded.has(item.handle)) append(item.handle, depth + 1);
        }
    };
    append(ROOT_HANDLE, 0);
    return rows;
}

export function ExtensionTreeView({ viewId }: { viewId: string }) {
    const scrollElement = useRef<HTMLDivElement>(null);
    const requests = useRef(new Map<string, string>());
    const loadChildrenReference = useRef<(parentHandle: string) => Promise<void>>(() =>
        Promise.resolve(),
    );
    const initializedExpanded = useRef(new Set<string>());
    const [children, setChildren] = useState<ReadonlyMap<string, readonly TreeItemDto[]>>(
        () => new Map(),
    );
    const [errors, setErrors] = useState<ReadonlyMap<string, string>>(() => new Map());
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
    const [loading, setLoading] = useState<ReadonlySet<string>>(() => new Set([ROOT_HANDLE]));
    const [activeHandle, setActiveHandle] = useState<string>();

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
                setChildren((current) => new Map(current).set(parentHandle, result.items));
                const newlyExpanded = result.items.filter(
                    (item) =>
                        item.collapsibleState === 'expanded' &&
                        !initializedExpanded.current.has(item.handle),
                );
                for (const item of newlyExpanded) initializedExpanded.current.add(item.handle);
                if (newlyExpanded.length > 0) {
                    setExpanded((current) => {
                        const next = new Set(current);
                        for (const item of newlyExpanded) next.add(item.handle);
                        return next;
                    });
                    queueMicrotask(() => {
                        for (const item of newlyExpanded) {
                            // eslint-disable-next-line no-void -- expanded provider items own their lazy child requests
                            void loadChildrenReference.current(item.handle);
                        }
                    });
                }
                if (parentHandle === ROOT_HANDLE && result.items[0])
                    setActiveHandle((current) => current ?? result.items[0].handle);
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
        [viewId],
    );
    useEffect(() => {
        loadChildrenReference.current = loadChildren;
    }, [loadChildren]);

    useEffect(() => {
        // eslint-disable-next-line no-void -- the loader reports failures in the tree's error row
        void loadChildren(ROOT_HANDLE);
        const unsubscribe = caxri.onEvent((event) => {
            if (event.event !== 'viewContainers.treeChanged' || event.payload.viewId !== viewId)
                return;
            if (!event.payload.handles) {
                setChildren(new Map());
                setExpanded(new Set());
                initializedExpanded.current.clear();
                setActiveHandle(undefined);
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
    }, [loadChildren, viewId]);

    const rows = useMemo(
        () => flattenRows(children, errors, expanded, loading),
        [children, errors, expanded, loading],
    );
    const virtualizer = useVirtualizer({
        count: rows.length,
        estimateSize: () => 28,
        getScrollElement: () => scrollElement.current,
        overscan: 10,
    });
    const focusIndex = (index: number): void => {
        const boundedIndex = Math.max(0, Math.min(rows.length - 1, index));
        const row = rows.at(boundedIndex);
        if (row?.kind !== 'item') return;
        setActiveHandle(row.item.handle);
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
        const willExpand = !expanded.has(row.item.handle);
        setExpanded((current) => {
            const next = new Set(current);
            if (willExpand) next.add(row.item.handle);
            else next.delete(row.item.handle);
            return next;
        });
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
                                    className="flex h-7 items-center gap-1.5 text-xs text-muted"
                                    style={{ paddingLeft: `${8 + row.depth * 16}px` }}
                                >
                                    <LoaderCircle className="animate-spin" size={14} /> Loading
                                    view…
                                </div>
                            ) : row.kind === 'error' ? (
                                <div
                                    className="flex h-7 items-center gap-1.5 text-xs text-danger"
                                    style={{ paddingLeft: `${8 + row.depth * 16}px` }}
                                >
                                    <AlertTriangle size={14} />
                                    <span className="min-w-0 flex-1 truncate">{row.message}</span>
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
                            ) : (
                                <TreeItemRow
                                    active={activeHandle === row.item.handle}
                                    index={virtualRow.index}
                                    row={row}
                                    rows={rows}
                                    onActivate={() => {
                                        runTreeCommand(row.item);
                                    }}
                                    onFocus={() => setActiveHandle(row.item.handle)}
                                    onFocusIndex={focusIndex}
                                    onToggle={() => toggle(row)}
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
    onActivate,
    onFocusIndex,
    onFocus,
    onToggle,
    row,
    rows,
}: {
    active: boolean;
    index: number;
    onActivate: () => void;
    onFocusIndex: (index: number) => void;
    onFocus: () => void;
    onToggle: () => void;
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
    const icon = (themeIconId === undefined ? undefined : themeIcons[themeIconId]) ?? {
        Icon: File,
    };
    const Icon = icon.Icon;
    /**
     * Chromium dispatches click(detail=1), click(detail=2), then dblclick for one double-click. The first click owns
     * the normal action; the second must not execute the same command again.
     */
    const handleClick = (event: MouseEvent<HTMLButtonElement>): void => {
        if (event.detail > 1) return;
        onToggle();
    };
    return (
        <button
            aria-expanded={isCollapsible ? isExpanded : undefined}
            aria-label={row.item.accessibilityLabel}
            aria-level={row.depth + 1}
            aria-posinset={positionInSet}
            aria-setsize={siblings.length}
            className="flex h-7 w-full min-w-0 items-center gap-1.5 border-0 bg-transparent pr-2 text-left text-xs text-foreground hover:bg-elevated focus-visible:bg-elevated focus-visible:outline-none"
            data-tree-index={index}
            role="treeitem"
            style={{ paddingLeft: `${8 + row.depth * 16}px` }}
            tabIndex={active ? 0 : -1}
            onClick={handleClick}
            onDoubleClick={isCollapsible ? onActivate : undefined}
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
                        onToggle();
                        break;
                    case 'ArrowLeft':
                        if (isCollapsible && isExpanded) onToggle();
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
                        onToggle();
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
            <Icon className={cn('flex-none', icon.className)} size={14} />
            <span className="min-w-0 grow basis-auto truncate">{row.item.label}</span>
            {row.item.description && (
                <span className="ml-auto min-w-0 flex-[0_999999_auto] truncate text-[11px] text-muted">
                    {row.item.description}
                </span>
            )}
        </button>
    );
}
