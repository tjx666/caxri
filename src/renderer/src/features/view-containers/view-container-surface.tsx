import type { ReactNode } from 'react';

import type {
    ExtensionBuiltinIconId,
    ViewContainerId,
    ViewContainerLocation,
    ViewIcon,
} from '@shared/views';
import type { LucideIcon } from 'lucide-react';
import {
    AlertTriangle,
    ChartNoAxesColumnIncreasing,
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
import { caxri } from '../../lib/caxri';
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
    status: ChartNoAxesColumnIncreasing,
} satisfies Record<ExtensionBuiltinIconId, LucideIcon>;

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
    const tabs = containers.map((container) => ({
        value: container.id,
        label: container.title,
        content: (
            <>
                <CatalogIcon icon={container.icon} />
                <span className="max-[1100px]:hidden" data-slot="chrome-tab-label">
                    {container.title}
                </span>
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
                    idPrefix={location === 'panel' ? 'panel' : 'secondary-sidebar'}
                    indicatorMaxWidth={location === 'secondarySidebar' ? 96 : undefined}
                    items={tabs}
                    tabClassName={
                        location === 'panel'
                            ? 'h-9 gap-1.5 px-3 text-[11px]'
                            : 'h-9 w-full gap-1 text-[11px]'
                    }
                    value={resolvedId ?? ''}
                    onValueChange={onSelect}
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
                        idPrefix={location === 'panel' ? 'panel' : 'secondary-sidebar'}
                        value={container.id}
                    >
                        {isActive && container.error ? (
                            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4 text-center text-xs text-muted">
                                <AlertTriangle className="text-danger" size={18} />
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
