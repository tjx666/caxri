import type { FocusEvent, KeyboardEvent } from 'react';
import { useLayoutEffect, useRef, useState } from 'react';

import { FolderGit2, GitBranch, TriangleAlert } from 'lucide-react';

import { Button } from '../../../components/ui/button';
import { Empty, EmptyMedia, EmptyTitle } from '../../../components/ui/empty';
import { Spinner } from '../../../components/ui/spinner';
import { useScrollEdge } from '../../../hooks/use-scroll-edge';
import type { SourceControlController } from './hooks/use-source-control-controller';
import { SourceControlHeader } from './source-control-header';
import { SourceControlHistory } from './source-control-history';
import { SourceControlProviderSection } from './source-control-provider-section';
import {
    isTextEntryElement,
    resolveActiveTreeRowId,
    shouldTreeClaimKeyInTextField,
    SourceControlTreeFocusProvider,
} from './source-control-tree-focus';
import {
    focusAdjacentTreeItem,
    focusFirstChildTreeItem,
    focusParentTreeItem,
    focusTreeItemEdge,
    NAVIGABLE_TREE_ITEM_SELECTOR,
    treeNavigationAction,
} from './source-control-tree-navigation';

export function SourceControlContent({ controller }: { controller: SourceControlController }) {
    return (
        <div
            className="secondary-sidebar-content git-panel flex min-h-0 flex-1 flex-col overflow-hidden"
            /*
             * Once a model is mounted the tree carries `aria-busy` itself, because the tree is the widget a background
             * refresh updates. Before that there is no tree, so the panel carries it. Exactly one element is busy at a
             * time, and neither of them stops taking input while it is.
             */
            aria-busy={(controller.status !== 'ready' && controller.isRefreshing) || undefined}
        >
            <SourceControlHeader controller={controller} />
            {controller.status === 'ready' ? (
                <SourceControlReadyContent controller={controller} />
            ) : (
                <SourceControlMessage controller={controller} />
            )}
        </div>
    );
}

function SourceControlMessage({
    controller,
}: {
    controller: Exclude<SourceControlController, { status: 'ready' }>;
}) {
    const state =
        controller.status === 'no-session'
            ? {
                  description: controller.noContextMessage,
                  icon: <GitBranch aria-hidden="true" size={28} />,
                  title: 'No Session selected',
              }
            : controller.status === 'loading'
              ? {
                    description: undefined,
                    icon: <Spinner aria-hidden="true" size={24} />,
                    title: controller.loadingMessage,
                }
              : controller.status === 'no-repository'
                ? {
                      description: 'This Project root is not a repository yet.',
                      icon: <FolderGit2 aria-hidden="true" size={28} />,
                      title: 'No Git repository',
                  }
                : {
                      description: controller.message,
                      icon: <TriangleAlert aria-hidden="true" className="text-danger" size={28} />,
                      title: 'Git is not available',
                  };

    return (
        <Empty className="min-h-0 flex-1 gap-2 p-4" aria-live="polite">
            <EmptyMedia>{state.icon}</EmptyMedia>
            <EmptyTitle
                className="rounded px-2 py-1 outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--accent)]"
                tabIndex={0}
            >
                {state.title}
            </EmptyTitle>
            {state.description && (
                <p className="m-0 max-w-64 text-[11px] leading-[1.45] text-pretty break-words text-muted">
                    {state.description}
                </p>
            )}
            {(controller.status === 'no-repository' || controller.status === 'unavailable') && (
                <Button
                    size="sm"
                    variant="secondary"
                    disabled={controller.isRefreshing}
                    onClick={controller.refresh}
                >
                    {controller.status === 'unavailable' ? 'Retry' : 'Refresh'}
                </Button>
            )}
        </Empty>
    );
}

function handleTreeKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    // A virtualized resource list already answered a move between two of its own rows (`source-control-tree-items.tsx`).
    if (event.defaultPrevented) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    // The commit path filter is a text field inside a row; its editing keys outrank the tree's navigation keys.
    if (isTextEntryElement(target) && !shouldTreeClaimKeyInTextField(event.key)) return;
    const row = target.closest<HTMLElement>('[role="treeitem"]');
    if (!row || row.closest('[role="tree"]') !== event.currentTarget) return;
    const isExpandable = row.hasAttribute('aria-expanded');
    const action = treeNavigationAction(
        event.key,
        isExpandable,
        row.getAttribute('aria-expanded') === 'true',
    );
    if (!action) return;
    event.preventDefault();
    switch (action) {
        case 'next':
            focusAdjacentTreeItem(row, 1);
            break;
        case 'previous':
            focusAdjacentTreeItem(row, -1);
            break;
        case 'first':
            focusTreeItemEdge(row, 'first');
            break;
        case 'last':
            focusTreeItemEdge(row, 'last');
            break;
        case 'parent':
            focusParentTreeItem(row);
            break;
        case 'child':
            focusFirstChildTreeItem(row);
            break;
        case 'expand':
        case 'collapse':
            row.click();
    }
}

function SourceControlReadyContent({
    controller,
}: {
    controller: Extract<SourceControlController, { status: 'ready' }>;
}) {
    const treeReference = useRef<HTMLDivElement>(null);
    useScrollEdge(treeReference);
    const [activeRowId, setActiveRowId] = useState<string>();
    useLayoutEffect(() => {
        const tree = treeReference.current;
        if (!tree) return;
        const reconcile = (): void => {
            const rowIds = [...tree.querySelectorAll<HTMLElement>(NAVIGABLE_TREE_ITEM_SELECTOR)]
                .map((row) => row.dataset.rowId)
                .filter((rowId): rowId is string => rowId !== undefined);
            setActiveRowId((current) => resolveActiveTreeRowId(rowIds, current));
        };
        reconcile();
        /*
         * Rows arrive from sections this component does not own and cannot depend on: File History and each
         * repository's `Commits` fetch their own pages, and a disclosure can drop the row that currently holds the
         * Tab stop. A dependency list built from this component's props never sees either, which would leave the
         * tree with zero tabbable rows. Observing the subtree is what keeps the single Tab stop on a rendered row.
         * Virtualized resource rows mount and unmount while scrolling, so each list keeps the Tab stop row mounted
         * (`sourceControlRenderedIndexes`); otherwise scrolling it away would hand the Tab stop back to the first row.
         */
        const observer = new MutationObserver(reconcile);
        // `disabled` is watched too: a commit row the current revision invalidated stops being focusable without the
        // row itself being added or removed, and the Tab stop must move off it.
        observer.observe(tree, {
            attributeFilter: ['disabled'],
            attributes: true,
            childList: true,
            subtree: true,
        });
        return () => observer.disconnect();
    }, []);
    /**
     * Focusing the tree container itself — which is how a view hands focus over from the chrome that opened it, and
     * what a click on the empty area below the last row does — lands on the row that owns the Tab stop instead of
     * parking focus on a container the arrow keys cannot move.
     */
    const forwardFocusToActiveRow = (event: FocusEvent<HTMLDivElement>): void => {
        if (event.target !== event.currentTarget) return;
        const tree = event.currentTarget;
        const rows = [...tree.querySelectorAll<HTMLElement>(NAVIGABLE_TREE_ITEM_SELECTOR)];
        const active = rows.find((row) => row.dataset.rowId === activeRowId) ?? rows.at(0);
        active?.focus();
    };
    return (
        <SourceControlTreeFocusProvider activeRowId={activeRowId} focusRow={setActiveRowId}>
            <div className="scroll-edge-shell relative flex min-h-0 flex-1 flex-col">
                <div
                    ref={treeReference}
                    className="git-repositories min-h-0 flex-1 overflow-auto border-b border-border outline-none"
                    data-scrolled="false"
                    aria-label={controller.model.accessibilityLabel}
                    /*
                     * A background refresh announces itself and never blocks input. `inert` used to sit here, which
                     * dropped focus to `<body>`, lost the roving position, and made arrow navigation skip the whole tree
                     * several times a minute; VS Code's SCM view blocks nothing while `git status` re-runs. A
                     * revision-bound action is refused at execution time instead (`use-source-control-controller.ts`).
                     */
                    aria-busy={controller.isRefreshing || undefined}
                    role="tree"
                    tabIndex={-1}
                    onFocus={forwardFocusToActiveRow}
                    onKeyDown={handleTreeKeyDown}
                >
                    {controller.model.fileHistory && (
                        <SourceControlHistory
                            descriptor={controller.model.fileHistory.history}
                            enabled={!controller.isRefreshing}
                            expansion={{
                                expanded: controller.fileHistoryExpanded,
                                setExpanded: controller.setFileHistoryExpanded,
                            }}
                            key={JSON.stringify([
                                controller.model.fileHistory.history.id,
                                controller.model.fileHistory.path ?? null,
                            ])}
                            level={1}
                            rowIdPrefix="file-history"
                            runAction={controller.runAction}
                            scope={{ kind: 'file', ...controller.model.fileHistory }}
                        />
                    )}
                    {controller.model.truncationMessage && (
                        <div
                            role="status"
                            aria-live="polite"
                            className="border-b border-border bg-surface px-3 py-1.5 text-[11px] text-muted"
                        >
                            {controller.model.truncationMessage}
                        </div>
                    )}
                    {controller.model.providers.map((provider) => (
                        <SourceControlProviderSection
                            controller={controller}
                            key={provider.id}
                            provider={provider}
                        />
                    ))}
                </div>
            </div>
        </SourceControlTreeFocusProvider>
    );
}
