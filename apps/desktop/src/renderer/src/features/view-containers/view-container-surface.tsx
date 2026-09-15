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
    Package,
    ScrollText,
    X,
} from 'lucide-react';

import { ChromeTabPanel, ChromeTabs } from '../../components/chrome-tabs';
import { PanelHeader } from '../../components/panel-header';
import { Button } from '../../components/ui/button';
import { Spinner } from '../../components/ui/spinner';
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
import type { ContainerBadge } from './view-badges';
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

/**
 * The container tab's aggregated badge.
 *
 * A badge draws a glyph or a tally, never both, and severity always wins the chip. That is VS Code's own composite-bar
 * rule — `getVisibleBadges()` in `compositeBarActions.ts` is a strict ladder over mutually exclusive `progress`,
 * `icon`, and `number` badges, and its `ErrorBadge`/`WarningBadge` have no number to show in the first place. Letting a
 * tally win instead left severity riding on the fill alone, so the Status tab's `5` and the Git tab's `5` were the same
 * size, shape, and position and differed only by color — indistinguishable to a colorblind user and in any greyscale
 * capture. {@link ContainerBadge} now makes that state unrepresentable rather than guarding it here.
 *
 * The glyph is the Workbench's, never the extension's: a badge reports meaning and the Workbench owns how meaning
 * looks. The tally the glyph displaced is not dropped — it stays in the joined `description` the tab publishes as its
 * tooltip and its accessible description, which is one thing Caxri does not copy from VS Code (`computeTitle()` there
 * drops the number from the label too).
 */
function ContainerBadgeChip({
    badge,
    containerId,
}: {
    badge: ContainerBadge;
    containerId: string;
}) {
    const fill = {
        count: 'bg-badge text-badge-foreground',
        error: 'bg-error-badge text-error-badge-foreground',
        warning: 'bg-warning-badge text-warning-badge-foreground',
    }[badge.kind];
    return (
        <span
            aria-hidden="true"
            className={`absolute -right-2 -bottom-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-none font-semibold ring-2 ring-surface ${fill}`}
            data-view-container-badge={containerId}
            data-view-container-badge-kind={badge.kind}
        >
            {/* The glyph is drawn at 9px, far below the size Lucide's stroke scaling assumes, so the stroke has to stay
                in screen pixels or it renders as a barely visible hairline. The two shapes differ in outline, not just
                in fill, so error and warning stay apart with no color at all. */}
            {badge.kind === 'count' ? (
                badge.text
            ) : badge.kind === 'error' ? (
                <X nonScalingStroke size={9} strokeWidth={3} />
            ) : (
                <AlertTriangle nonScalingStroke size={9} strokeWidth={2.5} />
            )}
        </span>
    );
}

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
    const [unscopedDesiredId, setUnscopedDesiredId] = useState<ViewContainerId>();
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
                <Spinner aria-hidden="true" size={15} style={{ width: 15, height: 15 }} /> Loading
                views…
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
                        <ContainerBadgeChip
                            badge={badges[container.id]!}
                            containerId={container.id}
                        />
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
                    onValueChange={(id) => {
                        if (hasUnscopedSelection) setUnscopedDesiredId(id);
                        else onSelect(id);
                    }}
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
                                                              <Spinner
                                                                  aria-hidden="true"
                                                                  size={13}
                                                                  style={{ width: 13, height: 13 }}
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
                                              {/* One caption row for every panel title; see `components/panel-header.tsx`. */}
                                              {!isOnlyView && <PanelHeader title={view.title} />}
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
