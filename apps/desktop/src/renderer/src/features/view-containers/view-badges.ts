import type { ViewBadge, ViewCatalogSnapshot, ViewContainerLocation } from '@caxri/protocol';

export interface ContainerBadge {
    /**
     * Empty when the winning severity has no countable tally; the icon alone then carries the badge.
     */
    text: string;
    description: string;
    kind: ViewBadge['kind'];
}

/**
 * Highest first. A container shows one severity, never a stack of differently-colored badges.
 */
const SEVERITY_ORDER = ['error', 'warning', 'count'] as const satisfies ReadonlyArray<
    ViewBadge['kind']
>;

/**
 * Every badge shares one cap, so a digit means the same width and the same thing on all of them.
 */
const COUNT_LIMIT = 99;

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

/**
 * Combines the badges of every view in a container into the single badge the container tab shows.
 *
 * Only the most severe kind present is tallied. Summing across kinds — the previous behavior — let a container with 20
 * ordinary items and 1 failure paint a red `21`, which reads as 21 failures. The description still names every
 * contributing view, so the dropped counts stay reachable without color or arithmetic.
 *
 * A severity whose winning group has even one uncounted badge shows no digit at all rather than a total that silently
 * omits it.
 */
export function aggregateContainerBadges(
    entries: ReadonlyArray<{ containerId: string; badge: ViewBadge | null | undefined }>,
): Readonly<Record<string, ContainerBadge | undefined>> {
    const grouped = new Map<string, ViewBadge[]>();
    for (const { containerId, badge } of entries) {
        // A severity with no tally is still activity worth showing; only an explicit zero means "nothing here".
        if (!badge || badge.count === 0) continue;
        grouped.set(containerId, [...(grouped.get(containerId) ?? []), badge]);
    }
    return Object.fromEntries(
        [...grouped].map(([id, badges]) => {
            const kind =
                SEVERITY_ORDER.find((candidate) =>
                    badges.some((badge) => badge.kind === candidate),
                ) ?? 'count';
            const winning = badges.filter((badge) => badge.kind === kind);
            const total = winning.every(({ count }) => count !== undefined)
                ? winning.reduce(
                      (sum, { count }) => Math.min(Number.MAX_SAFE_INTEGER, sum + count!),
                      0,
                  )
                : undefined;
            return [
                id,
                {
                    text:
                        total === undefined
                            ? ''
                            : total > COUNT_LIMIT
                              ? `${COUNT_LIMIT}+`
                              : String(total),
                    // Every view's description, not just the winning severity's: the badge hides counts, not causes.
                    description: badges.map(({ description }) => description).join(', '),
                    kind,
                },
            ];
        }),
    );
}
