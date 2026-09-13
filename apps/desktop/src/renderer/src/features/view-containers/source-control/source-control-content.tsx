import type { KeyboardEvent } from 'react';
import { useLayoutEffect, useRef, useState } from 'react';

import { FolderGit2, GitBranch, TriangleAlert } from 'lucide-react';

import { Button } from '../../../components/ui/button';
import { Empty, EmptyMedia, EmptyTitle } from '../../../components/ui/empty';
import { Spinner } from '../../../components/ui/spinner';
import {
    focusAdjacentTreeItem,
    focusFirstChildTreeItem,
    focusParentTreeItem,
    focusTreeItemEdge,
    treeNavigationAction,
} from '../resource-explorer/file-tree-navigation';
import type { SourceControlController } from './hooks/use-source-control-controller';
import { SourceControlHeader } from './source-control-header';
import { SourceControlHistory } from './source-control-history';
import { SourceControlProviderSection } from './source-control-provider-section';
import { SourceControlTreeFocusProvider } from './source-control-tree-row';

export function SourceControlContent({ controller }: { controller: SourceControlController }) {
    return (
        <div
            className="secondary-sidebar-content git-panel flex min-h-0 flex-1 flex-col overflow-hidden"
            aria-busy={controller.isRefreshing || controller.status === 'loading' || undefined}
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
                    Refresh
                </Button>
            )}
        </Empty>
    );
}

function handleTreeKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
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
    const [activeRowId, setActiveRowId] = useState<string | undefined>(
        () => controller.model.providers[0] && `provider:${controller.model.providers[0].id}`,
    );
    useLayoutEffect(() => {
        const rows = treeReference.current?.querySelectorAll<HTMLElement>('[role="treeitem"]');
        if (!rows?.length) return;
        if ([...rows].some((row) => row.dataset.rowId === activeRowId)) return;
        setActiveRowId(rows[0].dataset.rowId);
    }, [activeRowId, controller.model]);
    return (
        <SourceControlTreeFocusProvider activeRowId={activeRowId} focusRow={setActiveRowId}>
            <div
                ref={treeReference}
                className="git-repositories min-h-0 flex-1 overflow-auto border-b border-border"
                aria-label={controller.model.accessibilityLabel}
                inert={controller.isRefreshing}
                role="tree"
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
        </SourceControlTreeFocusProvider>
    );
}
