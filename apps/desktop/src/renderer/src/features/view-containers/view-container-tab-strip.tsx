import type { ReactNode } from 'react';

import type { ViewCatalogSnapshot, ViewContainerId, ViewContainerLocation } from '@caxri/protocol';

import { ChromeTabs } from '../../components/chrome-tabs';
import { CatalogIcon } from './catalog-icon';
import { ContainerBadgeChip } from './container-badge-chip';
import { ContainerTabTooltip } from './container-tab-tooltip';
import { useViewBadges } from './hooks/use-view-badges';

/**
 * Compact per-tab width budget for the SecondarySidebar's icon-only rail: the 48px `indicatorMaxWidth` passed below,
 * plus `chrome-tabs.tsx`'s own 8px `INDICATOR_INSET` on each side — the exact slot the indicator was already sized for.
 * Below this the SecondarySidebar's resizable width (240–600px, see `stores/chrome-layout.ts`) stretched three
 * icon-only tabs across the whole rail via `auto-cols-fr`, so the moving underline sat capped at 48px inside a much
 * wider, mostly empty slot — the "loose" spacing issue #1290 reported. Used only as a `maxWidth`, not a fixed width:
 * `auto-cols-fr` still divides whatever space is actually available, so a sidebar dragged near its minimum width, or an
 * extension contributing extra containers, still shrinks to fit instead of overflowing.
 */
const SECONDARY_SIDEBAR_TAB_WIDTH = 64;

/**
 * The tab strip a `ViewContainerSurface` renders above its containers, kept in its own file so the badge query stays on
 * this side of that boundary.
 *
 * `useViewBadges` follows the selected Session and re-resolves on every switch, and its result is a freshly built
 * record every time. Read in the surface, that re-rendered the surface — and with it every `ChromeTabPanel` it renders,
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
    const badges = useViewBadges(catalog, location);
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
                style={
                    location === 'secondarySidebar'
                        ? { maxWidth: containers.length * SECONDARY_SIDEBAR_TAB_WIDTH }
                        : undefined
                }
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
    );
}
