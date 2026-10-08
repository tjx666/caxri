import type { ViewBadge, ViewCatalogSnapshot, ViewContainerLocation } from '@caxri/protocol';

/**
 * The single badge a container tab draws.
 *
 * The union is the exclusivity rule: a severity has no `text`, so the chip structurally cannot paint a digit on a
 * severity fill, and a `count` has no severity, so it always paints the neutral one. `description` always names every
 * contributing view, including the ones whose tally the chip suppressed.
 */
export type ContainerBadge =
    | { kind: 'count'; text: string; description: string }
    | { kind: 'error' | 'warning'; description: string };

/**
 * Highest first. A container shows one severity, never a stack of differently-colored badges.
 */
const SEVERITY_ORDER = ['error', 'warning'] as const satisfies ReadonlyArray<ViewBadge['kind']>;

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
 * Picks the one badge a container tab shows.
 *
 * This is VS Code's composite-bar ladder with its top rung removed (Caxri has no progress badge): severity outranks
 * tally, exactly one rung wins, and the winner renders alone: `getVisibleBadges()` in
 * `src/vs/workbench/browser/parts/compositeBarActions.ts` returns the progress badges, else the icon badges, else the
 * number badges, never a blend.
 *
 * Severity replaces a tally instead of tinting it. A red `5` and a neutral `5` are the same size, shape, and position
 * and differ only by fill, so a colorblind user or a greyscale screenshot cannot tell "5 failures" from "5 changes".
 * Only `count` is totalled; summing across kinds once let 20 ordinary items and 1 failure paint a red `21`.
 *
 * The suppressed tally is not lost: every contributing badge's description is joined here, and the tab publishes that
 * string as its tooltip and its accessible description.
 */
export function selectContainerBadge(badges: readonly ViewBadge[]): ContainerBadge | undefined {
    // A severity has no tally to be zero, so only an explicit `count` of zero means "nothing here".
    const present = badges.filter((badge) => badge.kind !== 'count' || badge.count > 0);
    if (present.length === 0) return undefined;
    const description = present.map(({ description }) => description).join(', ');
    const severity = SEVERITY_ORDER.find((candidate) =>
        present.some((badge) => badge.kind === candidate),
    );
    if (severity) return { kind: severity, description };
    const total = present.reduce(
        (sum, badge) =>
            badge.kind === 'count' ? Math.min(Number.MAX_SAFE_INTEGER, sum + badge.count) : sum,
        0,
    );
    return {
        kind: 'count',
        text: total > COUNT_LIMIT ? `${COUNT_LIMIT}+` : String(total),
        description,
    };
}

/**
 * Groups every view's badge by container and reduces each group through {@link selectContainerBadge}.
 */
export function aggregateContainerBadges(
    entries: ReadonlyArray<{ containerId: string; badge: ViewBadge | null | undefined }>,
): Readonly<Record<string, ContainerBadge | undefined>> {
    const grouped = new Map<string, ViewBadge[]>();
    for (const { containerId, badge } of entries) {
        if (!badge) continue;
        grouped.set(containerId, [...(grouped.get(containerId) ?? []), badge]);
    }
    return Object.fromEntries(
        [...grouped].flatMap(([id, badges]) => {
            const selected = selectContainerBadge(badges);
            return selected ? [[id, selected] as const] : [];
        }),
    );
}
