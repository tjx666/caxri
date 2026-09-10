import type { ViewBadge, ViewCatalogSnapshot, ViewContainerLocation } from '@caxri/protocol';

export interface ContainerBadge {
    text: string;
    description: string;
    tone: 'neutral' | 'danger';
}

/**
 * Discovery is eligible: the first badge read activates its extension before a user opens the view.
 */
export function badgeViews(
    catalog: ViewCatalogSnapshot | undefined,
    location: ViewContainerLocation,
) {
    if (!catalog) return [];
    const containers = new Set(
        catalog.containers.flatMap((entry) => (entry.location === location ? [entry.id] : [])),
    );
    return catalog.views.flatMap((view) => {
        if (!view.badge || !containers.has(view.containerId) || view.source.kind !== 'extension')
            return [];
        const extensionId = view.source.extensionId;
        const extension = catalog.extensions.find((entry) => entry.id === extensionId);
        if (!extension || !['discovered', 'activating', 'active'].includes(extension.lifecycle))
            return [];
        return [
            { viewId: view.id, containerId: view.containerId, generation: extension.generation },
        ];
    });
}

export function aggregateContainerBadges(
    entries: ReadonlyArray<{ containerId: string; badge: ViewBadge | null | undefined }>,
): Readonly<Record<string, ContainerBadge | undefined>> {
    const totals = new Map<
        string,
        { count: number; descriptions: string[]; tone: 'neutral' | 'danger' }
    >();
    for (const { containerId, badge } of entries) {
        if (!badge || badge.count === 0) continue;
        const total = totals.get(containerId) ?? { count: 0, descriptions: [], tone: 'neutral' };
        total.count = Math.min(Number.MAX_SAFE_INTEGER, total.count + badge.count);
        total.descriptions.push(badge.description);
        if (badge.tone === 'danger') total.tone = 'danger';
        totals.set(containerId, total);
    }
    return Object.fromEntries(
        [...totals].map(([id, total]) => {
            const limit = total.tone === 'danger' ? 9 : 99;
            return [
                id,
                {
                    text: total.count > limit ? `${limit}+` : String(total.count),
                    description: total.descriptions.join(', '),
                    tone: total.tone,
                },
            ];
        }),
    );
}
