import type { ReactElement, ReactNode } from 'react';

import type { CommandId } from '@shared/commands';
import type {
    ExtensionBuiltinIconId,
    ViewContainerId,
    ViewContainerLocation,
    ViewIcon,
} from '@shared/views';
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
import { caxri } from '../../lib/caxri';
import { useCommandShortcut } from '../../lib/keybindings';
import { useCaxriQuery } from '../../queries/client';
import { tryCommand } from '../../stores/toasts';
import { getBuiltinViewComponent } from './builtin-components';
import { ExtensionTreeView } from './extension-tree-view';
import { resolveViewContainerId } from './resolution';

const builtinIcons = {
    'files': Files,
    'git-branch': GitBranch,
    'info': Info,
    'scroll-text': ScrollText,
} as const;

const extensionBuiltinIcons = {
    beaker: FlaskConical,
    status: Activity,
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
    // Builtin container commands are registry-backed CommandIds; extension ones simply have no bound shortcut.
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
    desiredId: ViewContainerId;
    location: ViewContainerLocation;
    onSelect: (id: ViewContainerId) => void;
    trailing?: ReactNode;
}) {
    const catalogQuery = useCaxriQuery('viewContainers.catalog', {});
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
    const idPrefix = location === 'panel' ? 'panel' : 'secondary-sidebar';
    const containersById = new Map(containers.map((container) => [container.id, container]));
    const tabs = containers.map((container) => ({
        value: container.id,
        label: container.title,
        // SecondarySidebar tabs are icon-only (the title lives in the tooltip); Panel tabs keep their inline label.
        content:
            location === 'panel' ? (
                <>
                    <CatalogIcon icon={container.icon} />
                    <span data-slot="chrome-tab-label">{container.title}</span>
                </>
            ) : (
                <CatalogIcon icon={container.icon} />
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
                                          title={container.title}
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
                        {isActive && container.error ? (
                            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4 text-center text-xs text-muted">
                                <AlertTriangle className="text-danger" size={18} />
                                <p className="font-medium text-foreground">Extension unavailable</p>
                                <p>{container.error.message}</p>
                                {container.source.kind === 'extension' && (
                                    <Button
                                        size="sm"
                                        variant="secondary"
                                        onClick={() => {
                                            // eslint-disable-next-line no-void -- intentional floating-promise discard, tryCommand() reports its own errors
                                            void tryCommand(
                                                'Unable to retry extension',
                                                async () => {
                                                    if (container.source.kind !== 'extension')
                                                        return;
                                                    const result = await caxri.request(
                                                        'extensions.retry',
                                                        {
                                                            extensionId:
                                                                container.source.extensionId,
                                                        },
                                                    );
                                                    if (!result.accepted && result.error)
                                                        throw Object.assign(
                                                            new Error(result.error.message),
                                                            { code: result.error.code },
                                                        );
                                                },
                                            );
                                        }}
                                    >
                                        Retry
                                    </Button>
                                )}
                            </div>
                        ) : (
                            isActive &&
                            views.map((view) => {
                                const isOnlyView = views.length === 1;
                                let content: ReactNode;
                                if (view.viewKind.kind === 'builtin-react') {
                                    const Component = getBuiltinViewComponent(
                                        view.viewKind.component,
                                    );
                                    content = <Component />;
                                } else content = <ExtensionTreeView viewId={view.id} />;
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
                            })
                        )}
                    </ChromeTabPanel>
                );
            })}
        </>
    );
}
