import type { ReactNode } from 'react';
import { useState } from 'react';

import type { ViewContainerId, ViewContainerLocation } from '@caxri/protocol';
import { AlertTriangle } from 'lucide-react';

import { ChromeTabPanel } from '../../components/chrome-tabs';
import { LoadingSkeleton } from '../../components/loading-skeleton';
import { PanelHeader } from '../../components/panel-header';
import { Button } from '../../components/ui/button';
import { Spinner } from '../../components/ui/spinner';
import { useTranslation } from '../../i18n';
import { awaitThenCleanup } from '../../lib/await-then-cleanup';
import { useCaxriQuery } from '../../queries/client';
import { tryCommand } from '../../stores/toasts';
import { getBuiltinViewComponent } from './builtin-components';
import { ControlledViewProvider } from './controlled-view-provider';
import { describeExtensionFailure } from './extension-failure';
import { ExtensionTreeView } from './extension-tree-view';
import { resolveViewContainerId } from './resolution';
import { ResourceExplorerView } from './resource-explorer/resource-explorer-view';
import { SourceControlView } from './source-control/source-control-view';
import { ViewContainerActivityProvider } from './view-container-activity';
import { retryExtension } from './view-container-commands';
import { viewTitle } from './view-container-labels';
import { ViewContainerTabStrip } from './view-container-tab-strip';

export function ViewContainerSurface({
    ariaLabel,
    desiredId,
    location,
    onSelect,
    trailing,
    hasUnscopedSelection = false,
}: {
    ariaLabel: string;
    desiredId?: ViewContainerId;
    location: ViewContainerLocation;
    onSelect: (id: ViewContainerId) => void;
    trailing?: ReactNode;
    hasUnscopedSelection?: boolean;
}) {
    const { t } = useTranslation();
    const [unscopedDesiredId, setUnscopedDesiredId] = useState<ViewContainerId>();
    const [retryingExtensionIds, setRetryingExtensionIds] = useState<ReadonlySet<string>>(
        () => new Set(),
    );
    const [shownContainerIds, setShownContainerIds] = useState<ReadonlySet<string>>(
        () => new Set(),
    );
    const catalogQuery = useCaxriQuery('viewContainers.catalog', {});
    if (catalogQuery.isPending)
        return (
            <LoadingSkeleton
                variant="list"
                className="min-h-0 flex-1 py-1"
                label={t('viewContainers.surface.loading')}
            />
        );
    if (catalogQuery.isError)
        return (
            <div
                role="alert"
                className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-xs text-muted"
            >
                <AlertTriangle size={15} /> {t('viewContainers.surface.loadFailed')}
                <Button
                    size="sm"
                    variant="secondary"
                    aria-disabled={catalogQuery.isFetching}
                    aria-busy={catalogQuery.isFetching}
                    onClick={() => {
                        if (catalogQuery.isFetching) return;
                        // eslint-disable-next-line no-void -- query state renders the retry outcome inline
                        void catalogQuery.refetch();
                    }}
                >
                    {t('common.retry')}
                </Button>
            </div>
        );
    const catalog = catalogQuery.data;
    const containers = catalog.containers.filter((container) => container.location === location);
    const resolvedId = resolveViewContainerId(
        hasUnscopedSelection ? unscopedDesiredId : desiredId,
        location,
        catalog,
    );
    // A container stays mounted (hidden) once it has been shown, so switching back does not rebuild its content:
    // re-mounting a large Files tree costs hundreds of mounts, and every view keeps its scroll, focus, and expansion.
    // Hidden keep-alive still must pause Server reads; `ViewContainerActivityProvider` is that gate.
    // Adjusting state during render (rather than in an effect) records the first show before the content commits,
    // so a container never mounts twice.
    if (resolvedId !== undefined && !shownContainerIds.has(resolvedId))
        setShownContainerIds(new Set(shownContainerIds).add(resolvedId));
    const idPrefix = location === 'panel' ? 'panel' : 'secondary-sidebar';
    return (
        <>
            <ViewContainerTabStrip
                ariaLabel={ariaLabel}
                catalog={catalog}
                containers={containers}
                idPrefix={idPrefix}
                location={location}
                resolvedId={resolvedId}
                trailing={trailing}
                onSelectContainer={(id) => {
                    if (hasUnscopedSelection) setUnscopedDesiredId(id);
                    else onSelect(id);
                }}
            />
            {containers.map((container) => {
                const isActive = container.id === resolvedId;
                const isMounted = isActive || shownContainerIds.has(container.id);
                const views = catalog.views.filter(
                    ({ containerId }) => containerId === container.id,
                );
                return (
                    <ChromeTabPanel
                        key={container.id}
                        active={isActive}
                        className="flex min-h-0 flex-1 flex-col overflow-hidden [&>*]:min-h-0"
                        idPrefix={idPrefix}
                        value={container.id}
                    >
                        <ViewContainerActivityProvider isActive={isActive}>
                            {container.error
                                ? isActive && (
                                      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4 text-center text-xs text-muted">
                                          <AlertTriangle className="text-danger" size={18} />
                                          <p className="font-medium text-foreground">
                                              {t('viewContainers.surface.extensionUnavailable')}
                                          </p>
                                          <p>{describeExtensionFailure(container.error, t)}</p>
                                          {container.source.kind === 'extension' &&
                                              (() => {
                                                  const extensionId = container.source.extensionId;
                                                  const isRetrying =
                                                      retryingExtensionIds.has(extensionId);
                                                  return (
                                                      <Button
                                                          disabled={isRetrying}
                                                          size="sm"
                                                          variant="secondary"
                                                          onClick={() => {
                                                              // Disabling for the duration of the request (rather than only until the
                                                              // catalog refetches) prevents a double-click from firing a second
                                                              // `extensions.retry` while the first is still outstanding.
                                                              setRetryingExtensionIds((current) =>
                                                                  new Set(current).add(extensionId),
                                                              );
                                                              // eslint-disable-next-line no-void -- intentional floating-promise discard, tryCommand() reports its own errors
                                                              void tryCommand(
                                                                  t(
                                                                      'viewContainers.surface.retryExtensionFailed',
                                                                  ),
                                                                  async () => {
                                                                      await awaitThenCleanup(
                                                                          retryExtension(
                                                                              extensionId,
                                                                          ),
                                                                          () => {
                                                                              setRetryingExtensionIds(
                                                                                  (current) => {
                                                                                      const next =
                                                                                          new Set(
                                                                                              current,
                                                                                          );
                                                                                      next.delete(
                                                                                          extensionId,
                                                                                      );
                                                                                      return next;
                                                                                  },
                                                                              );
                                                                          },
                                                                      );
                                                                  },
                                                              );
                                                          }}
                                                      >
                                                          {isRetrying && (
                                                              <Spinner
                                                                  aria-hidden="true"
                                                                  size={13}
                                                                  style={{ width: 13, height: 13 }}
                                                              />
                                                          )}
                                                          {t('common.retry')}
                                                      </Button>
                                                  );
                                              })()}
                                      </div>
                                  )
                                : isMounted &&
                                  views.map((view) => {
                                      const isOnlyView = views.length === 1;
                                      let content: ReactNode;
                                      if (view.viewKind.kind === 'builtin-react') {
                                          const Component = getBuiltinViewComponent(
                                              view.viewKind.component,
                                          );
                                          content = <Component />;
                                      } else if (view.viewKind.kind === 'tree')
                                          content = (
                                              <ExtensionTreeView
                                                  actions={view.actions}
                                                  extensionGeneration={
                                                      catalog.extensions.find(
                                                          ({ id }) =>
                                                              view.source.kind === 'extension' &&
                                                              id === view.source.extensionId,
                                                      )?.generation ?? 0
                                                  }
                                                  title={viewTitle(view, t)}
                                                  viewId={view.id}
                                              />
                                          );
                                      else
                                          content = (
                                              <ControlledViewProvider
                                                  actions={view.actions}
                                                  configurationDependencies={
                                                      view.configurationDependencies
                                                  }
                                                  providerGeneration={
                                                      catalog.extensions.find(
                                                          ({ id }) =>
                                                              view.source.kind === 'extension' &&
                                                              id === view.source.extensionId,
                                                      )?.generation ?? 0
                                                  }
                                                  kind={view.viewKind.kind}
                                                  presentation={view.presentation}
                                                  viewId={view.id}
                                              >
                                                  {view.viewKind.kind === 'resource-explorer' ? (
                                                      <ResourceExplorerView />
                                                  ) : (
                                                      <SourceControlView />
                                                  )}
                                              </ControlledViewProvider>
                                          );
                                      return (
                                          <div
                                              key={view.id}
                                              className="flex min-h-0 flex-1 flex-col overflow-hidden"
                                          >
                                              {/* One caption row for every panel title; see `components/panel-header.tsx`. */}
                                              {!isOnlyView && (
                                                  <PanelHeader title={viewTitle(view, t)} />
                                              )}
                                              {content}
                                          </div>
                                      );
                                  })}
                        </ViewContainerActivityProvider>
                    </ChromeTabPanel>
                );
            })}
        </>
    );
}
