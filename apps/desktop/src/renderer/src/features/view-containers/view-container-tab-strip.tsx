import type { ReactNode } from 'react';

import type { ViewCatalogSnapshot, ViewContainerId, ViewContainerLocation } from '@caxri/protocol';

import { ChromeTabs } from '../../components/chrome-tabs';
import { useTranslation } from '../../i18n';
import { useSessionViewScope } from '../../stores/selectors';
import { CatalogIcon } from './catalog-icon';
import { ContainerBadgeChip } from './container-badge-chip';
import { ContainerTabTooltip } from './container-tab-tooltip';
import { useViewBadges } from './hooks/use-view-badges';
import { viewContainerTitle } from './view-container-labels';

/**
 * The tab strip a `ViewContainerSurface` renders above its containers, kept in its own file so the badge query stays on
 * this side of that boundary.
 *
 * SecondarySidebar tabs divide the whole rail evenly (`auto-cols-fr`); the 48px `indicatorMaxWidth` keeps the moving
 * mark compact inside each wide slot. A per-tab width cap was tried and reverted: it left-aligned the strip and left
 * the rest of the rail empty.
 *
 * `useViewBadges` follows the selected Session and re-resolves on every switch, and its result is a freshly built
 * record every time. Read in the surface, that re-rendered the surface, and with it every `ChromeTabPanel` it renders,
 * including the hidden containers that stay mounted by design and have no stake in a tab's badge. Reading the badges
 * where they are shown keeps a badge change inside the strip.
 */
export function ViewContainerTabStrip({
    ariaLabel,
    catalog,
    containers,
    idPrefix,
    location,
    resolvedId,
    trailing,
    onSelectContainer,
}: {
    ariaLabel: string;
    catalog: ViewCatalogSnapshot;
    containers: ReadonlyArray<ViewCatalogSnapshot['containers'][number]>;
    idPrefix: string;
    location: ViewContainerLocation;
    resolvedId?: ViewContainerId;
    trailing?: ReactNode;
    onSelectContainer: (id: ViewContainerId) => void;
}) {
    const { t } = useTranslation();
    const badges = useViewBadges(catalog, location);
    const { sessionId } = useSessionViewScope();
    const containersById = new Map(containers.map((container) => [container.id, container]));
    const tabs = containers.map((container) => ({
        value: container.id,
        label: viewContainerTitle(container, t),
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
                    <span data-slot="chrome-tab-label">{viewContainerTitle(container, t)}</span>
                )}
            </>
        ),
    }));
    return (
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
                motionScope={sessionId}
                tabClassName={location === 'panel' ? 'h-9 gap-1.5 px-3 text-[11px]' : 'h-9 w-full'}
                value={resolvedId ?? ''}
                onValueChange={onSelectContainer}
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
                                              ? `${viewContainerTitle(container, t)}: ${badges[container.id]?.description}`
                                              : viewContainerTitle(container, t)
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
    );
}
