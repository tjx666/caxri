import type { ReactElement, ReactNode } from 'react';
import { useState } from 'react';

import type {
    CommandId,
    ExtensionBuiltinIconId,
    ViewContainerId,
    ViewContainerLocation,
    ViewIcon,
} from '@caxri/protocol';
import type { LucideIcon } from 'lucide-react';
import {
    Activity,
    AlertTriangle,
    Files,
    FlaskConical,
    GitBranch,
    Info,
    LoaderCircle,
    Package,
    ScrollText,
} from 'lucide-react';

import { ChromeTabPanel, ChromeTabs } from '../../components/chrome-tabs';
import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';
import { useCommandShortcut } from '../../lib/keybindings';
import { useCaxriQuery } from '../../queries/client';
import { tryCommand } from '../../stores/toasts';
import { getBuiltinViewComponent } from './builtin-components';
import { ControlledViewProvider } from './controlled-view-provider';
import { ExtensionTreeView } from './extension-tree-view';
import { useViewBadges } from './hooks/use-view-badges';
import { resolveViewContainerId } from './resolution';
import { ResourceExplorerView } from './resource-explorer/resource-explorer-view';
import { SourceControlView } from './source-control/source-control-view';
import { ViewContainerActivityProvider } from './view-container-activity';
import { retryExtension } from './view-container-commands';

const builtinIcons = {
    'files': Files,
    'git-branch': GitBranch,
    'info': Info,
    'scroll-text': ScrollText,
} as const;

const extensionBuiltinIcons = {
    'beaker': FlaskConical,
    'files': Files,
    'git-branch': GitBranch,
    'status': Activity,
} satisfies Record<ExtensionBuiltinIconId, LucideIcon>;

/**
 * Icon-only SecondarySidebar tabs surface their title (and shortcut, when one is bound) through a tooltip instead of an
 * inline label. `triggerId` must repeat the tab's own DOM id so Base UI's tooltip store keys to the id the tab
 * renders.
 */
function ContainerTabTooltip({
    children,
    commandId,
    title,
    triggerId,
}: {
    children: ReactElement;
    commandId: string;
    title: string;
    triggerId: string;
}) {
    // Product extension containers may opt into a stable CommandId so their live binding appears here too.
    const shortcut = useCommandShortcut(commandId as CommandId);
    return (
        <Tooltip content={title} shortcut={shortcut} triggerId={triggerId}>
            {children}
        </Tooltip>
    );
}

function CatalogIcon({ icon }: { icon: ViewIcon }) {
    if (icon.kind === 'resource') return <img alt="" className="size-4" src={icon.dataUrl} />;
    const builtinIconId = icon.kind === 'builtin' ? icon.id : undefined;
    let Icon: LucideIcon = Package;
    if (builtinIconId !== undefined) {
        if (builtinIconId in builtinIcons)
            Icon = builtinIcons[builtinIconId as keyof typeof builtinIcons];
        else if (builtinIconId in extensionBuiltinIcons)
            Icon = extensionBuiltinIcons[builtinIconId as ExtensionBuiltinIconId];
    }
    return <Icon size={16} />;
}

export function ViewContainerSurface({
    ariaLabel,
    desiredId,
    location,
    onSelect,
    trailing,
}: {
    ariaLabel: string;
    desiredId?: ViewContainerId;
    location: ViewContainerLocation;
    onSelect: (id: ViewContainerId) => void;
    trailing?: ReactNode;
}) {
    const [retryingExtensionIds, setRetryingExtensionIds] = useState<ReadonlySet<string>>(
        () => new Set(),
    );
    const [shownContainerIds, setShownContainerIds] = useState<ReadonlySet<string>>(
        () => new Set(),
    );
    const catalogQuery = useCaxriQuery('viewContainers.catalog', {});
    const badges = useViewBadges(catalogQuery.data, location);
    if (catalogQuery.isPending)
        return (
            <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-xs text-muted">
                <LoaderCircle className="animate-spin" size={15} /> Loading views…
            </div>
        );
    if (catalogQuery.isError)
        return (
            <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-xs text-danger">
                <AlertTriangle size={15} /> {catalogQuery.error.message}
            </div>
        );
    const catalog = catalogQuery.data;
    const containers = catalog.containers.filter((container) => container.location === location);
    const resolvedId = resolveViewContainerId(desiredId, location, catalog);
    // A container stays mounted (hidden) once it has been shown, so switching back does not rebuild its content:
    // re-mounting a large Files tree costs hundreds of mounts, and every view keeps its scroll, focus, and expansion.
    // Hidden keep-alive still must pause Server reads; `ViewContainerActivityProvider` is that gate.
    // Adjusting state during render (rather than in an effect) records the first show before the content commits,
    // so a container never mounts twice.
    if (resolvedId !== undefined && !shownContainerIds.has(resolvedId))
        setShownContainerIds(new Set(shownContainerIds).add(resolvedId));
    const idPrefix = location === 'panel' ? 'panel' : 'secondary-sidebar';
    const containersById = new Map(containers.map((container) => [container.id, container]));
    const tabs = containers.map((container) => ({
        value: container.id,
        label: container.title,
        description: badges[container.id]?.description,
        // SecondarySidebar tabs are icon-only (the title lives in the tooltip); Panel tabs keep their inline label.
        content: (
            <>
                <span className="relative flex size-4 items-center justify-center">
                    <CatalogIcon icon={container.icon} />
                    {badges[container.id] && (
                        <span
                            aria-hidden="true"
                            className={`absolute -right-2 -bottom-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-1 text-[10px] leading-none font-semibold ring-2 ring-surface ${badges[container.id]?.tone === 'danger' ? 'bg-danger text-danger-foreground' : 'bg-badge text-badge-foreground'}`}
                            data-view-container-badge={container.id}
                        >
                            {badges[container.id]?.text}
                        </span>
                    )}
                </span>
                {location === 'panel' && (
                    <span data-slot="chrome-tab-label">{container.title}</span>
                )}
            </>
        ),
    }));
    return (
        <>
            <div className="flex items-stretch">
                <ChromeTabs
                    ariaLabel={ariaLabel}
                    className={
                        location === 'panel'
                            ? 'flex h-9 items-end'
                            : 'grid h-11 flex-1 auto-cols-fr grid-flow-col items-end'
                    }
                    idPrefix={idPrefix}
                    indicatorMaxWidth={location === 'secondarySidebar' ? 48 : undefined}
                    items={tabs}
                    tabClassName={
                        location === 'panel' ? 'h-9 gap-1.5 px-3 text-[11px]' : 'h-9 w-full'
                    }
                    value={resolvedId ?? ''}
                    onValueChange={onSelect}
                    renderTab={
                        location === 'secondarySidebar'
                            ? (item, tab) => {
                                  const container = containersById.get(item.value);
                                  if (!container) return tab;
                                  return (
                                      <ContainerTabTooltip
                                          commandId={container.commandId}
                                          title={
                                              badges[container.id]
                                                  ? `${container.title}: ${badges[container.id]?.description}`
                                                  : container.title
                                          }
                                          triggerId={`${idPrefix}-tab-${container.id}`}
                                      >
                                          {tab}
                                      </ContainerTabTooltip>
                                  );
                              }
                            : undefined
                    }
                />
                {trailing}
            </div>
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
                                              Extension unavailable
                                          </p>
                                          <p>{container.error.message}</p>
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
                                                                  'Unable to retry extension',
                                                                  async () => {
                                                                      try {
                                                                          await retryExtension(
                                                                              extensionId,
                                                                          );
                                                                      } finally {
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
                                                                      }
                                                                  },
                                                              );
                                                          }}
                                                      >
                                                          {isRetrying && (
                                                              <LoaderCircle
                                                                  aria-hidden="true"
                                                                  className="animate-spin"
                                                                  size={13}
                                                              />
                                                          )}
                                                          Retry
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
                                                  title={view.title}
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
                                              {!isOnlyView && (
                                                  <h3 className="border-b border-border px-3 py-1.5 text-xs font-medium">
                                                      {view.title}
                                                  </h3>
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
