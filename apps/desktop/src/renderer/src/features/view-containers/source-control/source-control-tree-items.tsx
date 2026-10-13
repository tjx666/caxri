import type { DragEvent, KeyboardEvent, MouseEvent, RefObject } from 'react';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { SourceControlAction, SourceControlResource } from '@caxri/protocol';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { DiffStat } from '../../../components/diff-stat';
import { Button } from '../../../components/ui/button';
import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { FileTypeIcon } from '../../../icons/files/file-type-icon';
import { diffStatLabel } from '../../../lib/diff-stat-label';
import { startFilePathDrag } from '../../../lib/file-drag';
import { resolveRepositoryFilePath as resolveRepoFilePath } from '../../../lib/repository-file-path';
import { cn } from '../../../lib/utilities';
import { openFile } from '../../editor/document-commands';
import { observeKeepAliveElementRect } from '../virtual-tree-keep-alive';
import { sourceControlDecorationClassName } from './source-control-decorations';
import { SourceControlIcon } from './source-control-icon';
import { sourceControlActionMenuItems } from './source-control-row-menu';
import type { SourceControlTreeNode } from './source-control-tree';
import { sourceControlDirectoryExpansionKeys } from './source-control-tree';
import { useSourceControlTreeFocus } from './source-control-tree-focus';
import { treeNavigationAction } from './source-control-tree-navigation';
import { SourceControlTreeRow } from './source-control-tree-row';
import type { SourceControlVisibleRow } from './source-control-tree-rows';
import {
    flattenSourceControlTree,
    SOURCE_CONTROL_TREE_ROW_HEIGHT,
    sourceControlRenderedIndexes,
    sourceControlTreeNavigationTarget,
} from './source-control-tree-rows';

const resourceRowClassName =
    'git-row flex w-full items-center gap-2 h-7 px-2 border-0 bg-surface text-left cursor-pointer';

const virtualRowClassName = 'absolute top-0 left-0 w-full';

/**
 * The name and the status letter of a changed row wear the same `--git-*` color, which is the same color that file's
 * name wears in the Files tree and on its tab. `undefined` for an undecorated row, which keeps the row's own color.
 */
function resourceColorClassName(resource: SourceControlResource): string | undefined {
    return resource.decoration && sourceControlDecorationClassName(resource.decoration);
}

function Decoration({
    className,
    resource,
}: {
    className?: string;
    resource: SourceControlResource;
}) {
    const value = resource.decoration;
    if (!value) return null;
    return (
        <span
            className={cn(
                `status status-${value.identifier}`,
                'min-w-4 flex-none text-center font-mono font-bold',
                sourceControlDecorationClassName(value),
                className,
            )}
        >
            {value.label}
        </span>
    );
}

function handleResourceDragStart(
    event: DragEvent<HTMLButtonElement>,
    resourcePath: string | undefined,
): void {
    if (!resourcePath) return;
    startFilePathDrag(event.dataTransfer, resourcePath, false);
}

/**
 * The Source Control `role="tree"` element is also the panel's scroller. Every group's resource tree virtualizes
 * against that one shared scroller instead of owning a nested scroll box, so the panel keeps a single scrollbar.
 */
function sourceControlScroller(list: HTMLElement | null): HTMLElement | null {
    return list?.closest<HTMLElement>('[role="tree"]') ?? null;
}

/**
 * Tracks where a group's resource list starts inside the shared scroller's content, which is the virtualizer's
 * `scrollMargin`.
 *
 * Everything above the list can change height without re-rendering this component: File History and each repository's
 * `Commits` fetch their own pages, and every disclosure above animates its height. Each of those resizes a direct child
 * of the scroller, so observing those children (and re-observing when the set changes) catches them. A change that
 * keeps the enclosing section's height, one group shrinking while an earlier one grows, comes from a model refresh,
 * which re-renders this list, so every commit re-measures as well.
 */
function useScrollerOffset(list: RefObject<HTMLElement | null>): number {
    const [offset, setOffset] = useState(0);
    const measure = useRef<() => void>(undefined);
    useLayoutEffect(() => {
        const element = list.current;
        const scroller = sourceControlScroller(element);
        if (!element || !scroller) return;
        const update = (): void => {
            const next =
                element.getBoundingClientRect().top -
                scroller.getBoundingClientRect().top +
                scroller.scrollTop;
            setOffset((current) => (Math.abs(current - next) < 0.5 ? current : next));
        };
        measure.current = update;
        const resizeObserver = new ResizeObserver(update);
        for (const child of scroller.children) resizeObserver.observe(child);
        const mutationObserver = new MutationObserver(() => {
            resizeObserver.disconnect();
            for (const child of scroller.children) resizeObserver.observe(child);
            update();
        });
        mutationObserver.observe(scroller, { childList: true });
        update();
        return () => {
            measure.current = undefined;
            resizeObserver.disconnect();
            mutationObserver.disconnect();
        };
    }, [list]);
    // Deliberately dependency-free: see the JSDoc above.
    useLayoutEffect(() => {
        measure.current?.();
    });
    return offset;
}

interface SourceControlTreeItemsProperties {
    activeEditorResource?: string;
    expandedDirectories: Readonly<Record<string, boolean | undefined>>;
    /**
     * ARIA level of the top-level rows: 3 under a group caption, 2 when the provider header stands in for the caption.
     */
    level: number;
    nodes: readonly SourceControlTreeNode[];
    providerKey: string;
    repositoryRootPath?: string;
    runAction: (action: SourceControlAction) => void;
    setDirectoriesExpanded: (keys: readonly string[], isExpanded: boolean) => void;
}

/**
 * A group's changed-file tree, virtualized: only the rows near the viewport are mounted, so a group listing thousands
 * of changes costs the DOM a viewport's worth of rows.
 *
 * Rows stay `treeitem`s in the surrounding tree's single roving tabindex. Moves between two resource rows are answered
 * from the flattened model here (`scrollToIndex`, then focus once the target mounts) because the target may not be
 * mounted; every other key falls through to the tree's DOM walk in `source-control-content.tsx`, which stays correct
 * because the boundary rows and the Tab stop row are always mounted (`sourceControlRenderedIndexes`).
 *
 * File and folder rows omit a hover tooltip on purpose: the path is already the row's accessible name, and a
 * cursor-anchored card sits over the adjacent diff while the user is reading it. Both advertise their Option-click
 * gesture through `aria-keyshortcuts` instead: a file row only when it has a working copy to open, a folder row
 * unconditionally, since every folder supports the Alt+Enter / Alt-click recursive toggle. Trailing Discard actions
 * keep their own tooltips.
 */
export function SourceControlTreeItems({
    activeEditorResource,
    expandedDirectories,
    level,
    nodes,
    providerKey,
    repositoryRootPath,
    runAction,
    setDirectoriesExpanded,
}: SourceControlTreeItemsProperties) {
    const listReference = useRef<HTMLDivElement>(null);
    const pendingFocusRowId = useRef<string>(undefined);
    const { activeRowId } = useSourceControlTreeFocus();
    const rows = useMemo(
        () => flattenSourceControlTree(nodes, providerKey, expandedDirectories),
        [expandedDirectories, nodes, providerKey],
    );
    const activeIndex = rows.findIndex((row) => row.rowId === activeRowId);
    const scrollMargin = useScrollerOffset(listReference);
    // TanStack Virtual is knowingly incompatible with React Compiler memoization; the compiler
    // skips this component, which is the library's documented, expected behavior.
    // eslint-disable-next-line react-hooks/incompatible-library -- see above
    const virtualizer = useVirtualizer({
        count: rows.length,
        estimateSize: () => SOURCE_CONTROL_TREE_ROW_HEIGHT,
        getItemKey: (index) => rows[index].rowId,
        getScrollElement: () => sourceControlScroller(listReference.current),
        observeElementRect: observeKeepAliveElementRect,
        overscan: 10,
        rangeExtractor: (range) =>
            sourceControlRenderedIndexes(defaultRangeExtractor(range), range.count, [activeIndex]),
        scrollMargin,
    });

    // Deliberately dependency-free: a pending move completes on whichever commit mounts its target row.
    useLayoutEffect(() => {
        const rowId = pendingFocusRowId.current;
        if (rowId === undefined) return;
        const target = listReference.current?.querySelector<HTMLElement>(
            `[data-row-id="${CSS.escape(rowId)}"]`,
        );
        if (!target) return;
        pendingFocusRowId.current = undefined;
        target.focus();
    });

    const focusRowAt = (index: number): void => {
        const { rowId } = rows[index];
        const target = listReference.current?.querySelector<HTMLElement>(
            `[data-row-id="${CSS.escape(rowId)}"]`,
        );
        if (target) {
            target.focus();
            return;
        }
        pendingFocusRowId.current = rowId;
        virtualizer.scrollToIndex(index, { align: 'auto' });
    };

    /**
     * Mirrors the tree-level handler's guards so the two never disagree about which keys are navigation. A move this
     * list answers is `preventDefault`ed, which the tree-level handler reads as already handled.
     */
    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
        if (event.defaultPrevented) return;
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (!(event.target instanceof HTMLElement)) return;
        const row = event.target.closest<HTMLElement>('[role="treeitem"]');
        const index = rows.findIndex((candidate) => candidate.rowId === row?.dataset.rowId);
        if (!row || index === -1) return;
        const action = treeNavigationAction(
            event.key,
            row.hasAttribute('aria-expanded'),
            row.getAttribute('aria-expanded') === 'true',
        );
        const target = action && sourceControlTreeNavigationTarget(rows, index, action);
        if (target === undefined) return;
        event.preventDefault();
        focusRowAt(target);
    };

    return (
        // Presentational wrapper: the rows are `treeitem`s of the surrounding tree, and the key handler only listens.
        <div
            ref={listReference}
            className="relative"
            role="none"
            style={{ height: virtualizer.getTotalSize() }}
            onKeyDown={handleKeyDown}
        >
            {virtualizer.getVirtualItems().map((virtualRow) => (
                <SourceControlVirtualRow
                    activeEditorResource={activeEditorResource}
                    key={virtualRow.key}
                    level={level}
                    offset={virtualRow.start - scrollMargin}
                    providerKey={providerKey}
                    repositoryRootPath={repositoryRootPath}
                    row={rows[virtualRow.index]}
                    runAction={runAction}
                    setDirectoriesExpanded={setDirectoriesExpanded}
                />
            ))}
        </div>
    );
}

function SourceControlVirtualRow({
    activeEditorResource,
    level,
    offset,
    providerKey,
    repositoryRootPath,
    row,
    runAction,
    setDirectoriesExpanded,
}: Omit<SourceControlTreeItemsProperties, 'expandedDirectories' | 'nodes'> & {
    offset: number;
    row: SourceControlVisibleRow;
}) {
    const { t } = useTranslation();
    const { depth, node } = row;
    const position = { transform: `translateY(${offset}px)` };
    const setInfo = { 'aria-posinset': row.positionInSet, 'aria-setsize': row.setSize };
    if (node.kind === 'directory') {
        const isExpanded = row.isExpanded;
        const expansionKey = row.expansionKey ?? `${providerKey}:${node.path}`;
        const directoryPath = resolveRepoFilePath(repositoryRootPath, node.path);
        return (
            <div className={virtualRowClassName} style={position}>
                <SourceControlTreeRow
                    rowId={row.rowId}
                    level={level + depth}
                    className="git-tree-directory flex h-7 w-full cursor-pointer items-center gap-1.5 border-0 bg-surface pr-2 text-left text-foreground hover:bg-elevated"
                    style={{ paddingLeft: 8 + depth * 14 }}
                    aria-expanded={isExpanded}
                    aria-keyshortcuts="Alt"
                    aria-description={node.lineStats && diffStatLabel(node.lineStats, t)}
                    data-path={node.path}
                    {...setInfo}
                    draggable={Boolean(directoryPath)}
                    onDragStart={(event) => handleResourceDragStart(event, directoryPath)}
                    onClick={(event) =>
                        setDirectoriesExpanded(
                            event.altKey
                                ? sourceControlDirectoryExpansionKeys(node, providerKey)
                                : [expansionKey],
                            !isExpanded,
                        )
                    }
                    onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
                        if (event.key !== 'Enter' || !event.altKey) return;
                        event.preventDefault();
                        setDirectoriesExpanded(
                            sourceControlDirectoryExpansionKeys(node, providerKey),
                            !isExpanded,
                        );
                    }}
                >
                    {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    <FileTypeIcon
                        entry={{ kind: 'directory', name: node.name }}
                        expanded={isExpanded}
                    />
                    <span className="min-w-0 flex-1 truncate">{node.name}</span>
                    {node.lineStats && (
                        <>
                            <DiffStat {...node.lineStats} className="text-[11px]" />
                            {/*
                             * Stands in for a file row's status letter (`gap-2` + `min-w-4`) so directory counts line
                             * up in the same column as the file counts beneath them.
                             */}
                            <span aria-hidden="true" className="ml-0.5 w-4 flex-none" />
                        </>
                    )}
                </SourceControlTreeRow>
            </div>
        );
    }
    const resource = node.resource;
    const trailingActions = resource.actions ?? [];
    const resourcePath = resolveRepoFilePath(repositoryRootPath, resource.path);
    /**
     * A deleted path has no working-tree file left to open, so it keeps the plain diff activation only.
     */
    const openablePath = resource.decoration?.identifier === 'deleted' ? undefined : resourcePath;
    const onResourceClick = (event: MouseEvent<HTMLButtonElement>): void => {
        if (openablePath && event.altKey) {
            // `openFile` (not `openEditorTab`) reads the file first and only creates the tab on
            // success, so a path that vanished since the last refresh toasts instead of leaving
            // a tab stuck on "Loading file…".
            // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
            void openFile(openablePath);
            return;
        }
        if (resource.action) runAction(resource.action);
    };
    return (
        // The absolutely positioned row wrapper is also the containing block the trailing actions position against.
        <div className={cn('git-row-container group', virtualRowClassName)} style={position}>
            <SourceControlTreeRow
                rowId={row.rowId}
                level={level + depth}
                menuItems={sourceControlActionMenuItems(trailingActions, runAction)}
                className={cn(
                    resourceRowClassName,
                    'hover:bg-elevated',
                    activeEditorResource === resource.editorResource && 'active bg-elevated',
                )}
                style={{ paddingLeft: 10 + depth * 14 }}
                data-path={resource.path}
                aria-label={resource.accessibilityLabel}
                aria-description={resource.lineStats && diffStatLabel(resource.lineStats, t)}
                aria-keyshortcuts={openablePath ? 'Alt' : undefined}
                {...setInfo}
                draggable={Boolean(resourcePath)}
                onDragStart={(event) => handleResourceDragStart(event, resourcePath)}
                onClick={onResourceClick}
            >
                <SourceControlIcon icon={resource.icon} />
                <span className={cn('min-w-0 flex-1 truncate', resourceColorClassName(resource))}>
                    {node.name}
                </span>
                {resource.lineStats && (
                    <DiffStat
                        {...resource.lineStats}
                        className={cn(
                            'text-[11px]',
                            trailingActions.length > 0 &&
                                'group-focus-within:invisible group-hover:invisible',
                        )}
                    />
                )}
                <Decoration
                    resource={resource}
                    className={
                        trailingActions.length > 0
                            ? 'group-focus-within:invisible group-hover:invisible'
                            : undefined
                    }
                />
            </SourceControlTreeRow>
            {trailingActions.map((action, index) => (
                <Tooltip content={action.tooltip ?? action.label} key={action.id}>
                    <Button
                        className={
                            index === 0
                                ? 'git-discard-file absolute top-1/2 right-1 hidden size-5 -translate-y-1/2 group-focus-within:flex group-hover:flex'
                                : 'git-discard-file absolute top-1/2 hidden size-5 -translate-y-1/2 group-focus-within:flex group-hover:flex'
                        }
                        style={index === 0 ? undefined : { right: 4 + index * 20 }}
                        size="icon"
                        variant="ghost"
                        tabIndex={-1}
                        aria-label={action.accessibilityLabel ?? action.label}
                        disabled={action.disabled}
                        onClick={() => runAction(action)}
                    >
                        <SourceControlIcon icon={action.icon} />
                    </Button>
                </Tooltip>
            ))}
        </div>
    );
}
