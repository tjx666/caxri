import { memo, useCallback, useEffect, useMemo, useRef } from 'react';

import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';

import { ContextMenuTrigger } from '../../../components/context-menu-trigger';
import { useLatestReference } from '../../../hooks/use-latest-reference';
import { useScrollEdge } from '../../../hooks/use-scroll-edge';
import { useTranslation } from '../../../i18n';
import { useGitChildRepo, useGitDecoration } from '../../../stores/git-decorations';
import { virtualTreeRenderedIndexes } from '../virtual-tree-range';
import {
    FileTreeCreateRow,
    FileTreeItem,
    FileTreeNotice,
    FileTreeRowContent,
} from './file-tree-item';

/**
 * Memoized because the virtualized tree re-renders on every scroll frame; a row whose props did not change keeps its
 * rendered subtree, and its own store subscriptions still re-render it when its state does.
 */
const MemoizedFileTreeItem = memo(FileTreeItem);
import type { EditRequest, FocusTarget } from './file-tree-item-types';
import type { FileTreeNavigator } from './file-tree-navigation-context';
import { FileTreeNavigationContext } from './file-tree-navigation-context';
import { fileTreeRootMenu } from './file-tree-root-context-menu';
import {
    FILE_TREE_ROW_HEIGHT,
    fileTreeRevealOffset,
    fileTreeRowStyle,
    stickyCoverage,
    stickyFileTreeRows,
} from './file-tree-row-style';
import type { FileTreeEntryRow, FileTreeRow } from './file-tree-rows';
import { fileTreeNavigationTarget } from './file-tree-rows';
import { useFileTreeRows } from './hooks/use-file-tree-rows';
import type { ResourceExplorerController } from './hooks/use-resource-explorer-controller';
import {
    activeResourceExplorerScope,
    clearScopeRevealPath,
    setScopeFocusPath,
    setScopeSelectedPath,
    useActiveRevealRequest,
    useActiveSelectedPath,
} from './resource-explorer-scope-store';

/**
 * A pinned ancestor in the sticky overlay. It is a visual duplicate of a row that has scrolled away, so it stays out of
 * the accessibility tree and the Tab order; clicking it scrolls the real row back to its slot and focuses it, the way
 * VS Code's sticky scroll hands a click to the underlying node.
 */
function FileTreeStickyRow({
    onActivate,
    row,
    top,
    zIndex,
}: {
    onActivate: () => void;
    row: FileTreeEntryRow;
    top: number;
    zIndex: number;
}) {
    const decoration = useGitDecoration(row.entry.path);
    const childRepo = useGitChildRepo(row.entry.path);
    return (
        /**
         * The hover color is layered over the opaque surface as a background image rather than replacing it: the list
         * hover color is translucent, and a pinned row painted with it alone let the rows scrolling underneath show
         * through the pinned name.
         */
        <div
            aria-hidden
            className="file-tree-sticky-row absolute inset-x-0 flex h-7 cursor-pointer items-center gap-2 bg-surface pr-2 text-foreground hover:bg-[linear-gradient(var(--list-hover-background),var(--list-hover-background))] hover:text-list-hover-foreground"
            data-path={row.entry.path}
            style={{ ...fileTreeRowStyle({ depth: row.depth, isDirectory: true }), top, zIndex }}
            role="presentation"
            title={row.entry.path}
            onClick={onActivate}
        >
            <FileTreeRowContent
                childRepo={childRepo}
                decoration={decoration}
                description=""
                descriptionId=""
                entry={row.entry}
                expanded
                isDirectory
            />
        </div>
    );
}

/**
 * The Files tree: a virtualized, flattened list of every expanded listing with a VS Code-style sticky ancestor overlay.
 *
 * Only rows near the viewport are mounted, so a directory with thousands of entries costs a screenful of DOM. Anything
 * that used to walk the DOM (arrow-key movement, Editor reveal, the pinned ancestors) now reads the flattened model
 * instead, because the row it needs may not be mounted. Rows still own their own interactions and store subscriptions.
 */
export function FileTree({ controller }: { controller: ResourceExplorerController }) {
    const { t } = useTranslation();
    const { editing, projectId } = controller;
    const root = controller.session.rootPath;
    const scrollElement = useRef<HTMLDivElement>(null);
    useScrollEdge(scrollElement);
    const composingDirectory = editing?.kind === 'create' ? editing.directory : undefined;
    const rows = useFileTreeRows({
        composingDirectory,
        projectId,
        root,
    });
    const indexByPath = useMemo(() => {
        const indexes = new Map<string, number>();
        for (const [index, row] of rows.entries())
            if (row.kind === 'entry') indexes.set(row.entry.path, index);
        return indexes;
    }, [rows]);

    // The controller rebuilds these on every render; routing them through a ref keeps the memoized rows stable.
    const latest = useLatestReference({
        requestFocus: controller.requestFocus,
        setEditing: controller.setEditing,
    });
    const requestFocus = useCallback(
        (target: FocusTarget) => latest.current.requestFocus(target),
        [latest],
    );
    const setEditing = useCallback(
        (request?: EditRequest) => latest.current.setEditing(request),
        [latest],
    );

    /*
     * The selected row owns the roving Tab stop (the first root row does with no selection), and the focused row owns
     * DOM focus. Both stay mounted whatever the scroll position, so Tab can always re-enter the tree and a focused row
     * scrolled out of view does not drop focus to `<body>`.
     */
    const selectedPath = useActiveSelectedPath();
    const focusedPath = useRef<string | undefined>(undefined);
    const tabStopIndex =
        selectedPath === undefined
            ? rows.findIndex((row) => row.kind === 'entry')
            : (indexByPath.get(selectedPath) ?? -1);
    const keptIndexes = useLatestReference([
        tabStopIndex,
        focusedPath.current === undefined ? -1 : (indexByPath.get(focusedPath.current) ?? -1),
    ]);

    // TanStack Virtual is knowingly incompatible with React Compiler memoization; the compiler skips this component,
    // which is the library's documented, expected behavior. Row identity is preserved by the `FileTreeItem` memo.
    // eslint-disable-next-line react-hooks/incompatible-library -- see above
    const virtualizer = useVirtualizer({
        count: rows.length,
        estimateSize: () => FILE_TREE_ROW_HEIGHT,
        getItemKey: (index) => rows[index].key,
        getScrollElement: () => scrollElement.current,
        overscan: 10,
        rangeExtractor: (range) =>
            virtualTreeRenderedIndexes(
                defaultRangeExtractor(range),
                range.count,
                keptIndexes.current,
            ),
    });

    const revealRow = (index: number): void => {
        const scroller = scrollElement.current;
        const extent = virtualizer.measurementsCache.at(index);
        const row = rows.at(index);
        if (!scroller || !extent || !row) return;
        const offset = fileTreeRevealOffset({
            depth: row.depth,
            extent,
            scrollOffset: scroller.scrollTop,
            viewportHeight: scroller.clientHeight,
        });
        if (offset !== undefined) virtualizer.scrollToOffset(offset);
    };
    const focusRow = (index: number): void => {
        const row = rows.at(index);
        const scope = activeResourceExplorerScope();
        if (!scope || row?.kind !== 'entry') return;
        revealRow(index);
        setScopeFocusPath(scope.scopeId, row.entry.path);
    };

    const latestNavigation = useLatestReference({ focusRow, indexByPath, rows });
    const navigator = useMemo<FileTreeNavigator>(
        () => ({
            move: (path, action) => {
                const {
                    focusRow: focus,
                    indexByPath: indexes,
                    rows: current,
                } = latestNavigation.current;
                const from = indexes.get(path);
                if (from === undefined) return;
                const target = fileTreeNavigationTarget(current, from, action);
                if (target !== undefined) focus(target);
            },
        }),
        [latestNavigation],
    );

    const revealRequest = useActiveRevealRequest();
    useEffect(() => {
        if (!revealRequest) return;
        const index = indexByPath.get(revealRequest.path);
        if (index === undefined) return;
        revealRow(index);
        const scope = activeResourceExplorerScope();
        if (scope) clearScopeRevealPath(scope.scopeId, revealRequest);
        // `revealRow` reads the live virtualizer; the request and the row model are what decide when to run.
        // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
    }, [indexByPath, revealRequest]);

    /*
     * The inline create field focuses itself on mount, but it can open in a directory scrolled out of the virtualized
     * window: the title bar's New File targets the root from any scroll position, where it would never mount.
     */
    const composingIndex =
        composingDirectory === undefined
            ? -1
            : rows.findIndex(
                  (row) => row.kind === 'create' && row.directory === composingDirectory,
              );
    useEffect(() => {
        if (composingIndex !== -1) revealRow(composingIndex);
        // `revealRow` reads the live virtualizer; only a newly opened field should scroll.
        // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
    }, [composingIndex]);

    const scrollOffset = virtualizer.scrollOffset ?? 0;
    const sticky = stickyFileTreeRows(
        rows,
        scrollOffset,
        (index) => virtualizer.measurementsCache.at(index),
        (offset) => virtualizer.getVirtualItemForOffset(offset)?.index,
    );
    const stickyBottom = sticky.reduce(
        (bottom, pinned) => Math.max(bottom, pinned.top + FILE_TREE_ROW_HEIGHT),
        0,
    );
    const activateSticky = (index: number): void => {
        const row = rows[index];
        const extent = virtualizer.measurementsCache.at(index);
        const scope = activeResourceExplorerScope();
        if (!extent || !scope || row.kind !== 'entry') return;
        virtualizer.scrollToOffset(Math.max(0, extent.start - stickyCoverage(row.depth)));
        setScopeSelectedPath(scope.scopeId, row.entry.path);
        setScopeFocusPath(scope.scopeId, row.entry.path);
    };

    const renderRow = (row: FileTreeRow) => {
        switch (row.kind) {
            case 'entry': {
                return (
                    <MemoizedFileTreeItem
                        depth={row.depth}
                        editing={editing}
                        entry={row.entry}
                        index={row.index}
                        projectId={projectId}
                        projectRoot={root}
                        requestFocus={requestFocus}
                        setEditing={setEditing}
                        setSize={row.setSize}
                    />
                );
            }
            case 'create': {
                return editing?.kind === 'create' ? (
                    <FileTreeCreateRow
                        depth={row.depth}
                        directory={row.directory}
                        editing={editing}
                        requestFocus={requestFocus}
                        setEditing={setEditing}
                    />
                ) : undefined;
            }
            case 'empty': {
                return <FileTreeNotice depth={row.depth} />;
            }
            case 'truncated': {
                return <FileTreeNotice depth={row.depth} truncatedCount={row.count} />;
            }
        }
    };
    const isMeasured = (row: FileTreeRow): boolean =>
        row.kind === 'create' ||
        (row.kind === 'entry' &&
            editing?.kind === 'rename' &&
            editing.entry.path === row.entry.path);

    return (
        <div className="scroll-edge-shell relative flex min-h-0 flex-1 flex-col">
            <ContextMenuTrigger menu={() => fileTreeRootMenu(controller)}>
                <div
                    ref={scrollElement}
                    role="tree"
                    aria-label={t('viewContainers.files.treeLabel')}
                    className="file-list min-h-0 flex-1 overflow-auto"
                    data-scrolled="false"
                    onBlur={(event) => {
                        if (!event.currentTarget.contains(event.relatedTarget))
                            focusedPath.current = undefined;
                    }}
                    onDragOver={controller.onProjectRootDragOver}
                    onDrop={controller.dropIntoProjectRoot}
                    onFocus={(event) => {
                        const wrapper = event.target.closest<HTMLElement>('[data-index]');
                        const index = wrapper ? Number(wrapper.dataset.index) : NaN;
                        const current = rows.at(index);
                        focusedPath.current =
                            current?.kind === 'entry' ? current.entry.path : undefined;
                    }}
                >
                    {sticky.length > 0 && (
                        <div aria-hidden className="file-tree-sticky sticky top-0 z-10 h-0">
                            {sticky.map((pinned, slot) => {
                                const row = rows[pinned.index];
                                return row.kind === 'entry' ? (
                                    <FileTreeStickyRow
                                        key={row.key}
                                        row={row}
                                        top={pinned.top}
                                        zIndex={sticky.length - slot}
                                        onActivate={() => activateSticky(pinned.index)}
                                    />
                                ) : undefined;
                            })}
                            <div
                                className="file-tree-sticky-shadow pointer-events-none absolute inset-x-0 h-1.5"
                                style={{ top: stickyBottom }}
                            />
                        </div>
                    )}
                    <FileTreeNavigationContext value={navigator}>
                        <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
                            {virtualizer.getVirtualItems().map((virtualRow) => {
                                const row = rows[virtualRow.index];
                                return (
                                    <div
                                        key={virtualRow.key}
                                        ref={
                                            isMeasured(row) ? virtualizer.measureElement : undefined
                                        }
                                        className="absolute top-0 left-0 w-full"
                                        data-index={virtualRow.index}
                                        role="none"
                                        style={{ transform: `translateY(${virtualRow.start}px)` }}
                                    >
                                        {renderRow(row)}
                                    </div>
                                );
                            })}
                        </div>
                    </FileTreeNavigationContext>
                </div>
            </ContextMenuTrigger>
        </div>
    );
}
