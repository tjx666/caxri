import type { ViewBadge, ViewCatalogSnapshot, ViewContainerLocation } from '@caxri/protocol';
import { useQueries } from '@tanstack/react-query';

import { useSelectedSession } from '../../../stores/selectors';
import { aggregateContainerBadges, badgeViews } from '../view-badges';
import { controlledViewQueryKey, viewOperation } from '../view-operation-client';

export function useViewBadges(
    catalog: ViewCatalogSnapshot | undefined,
    location: ViewContainerLocation,
) {
    const session = useSelectedSession();
    const context = session
        ? {
              kind: 'session' as const,
              sessionId: session.id,
              workbenchRootProjectId: session.workbenchRootProjectId,
          }
        : { kind: 'no-session' as const };
    const contextKey = session ? `${session.id}:${session.workbenchRootProjectId}` : 'no-session';
    const views = session ? badgeViews(catalog, location) : [];
    const queries = useQueries({
        queries: views.map((view) => ({
            /**
             * Inactive scopes receive no provider events; returning must revalidate even a recently cached badge.
             */
            staleTime: 0,
            queryKey: controlledViewQueryKey(
                view.viewId,
                'badge.snapshot',
                {},
                contextKey,
                String(view.generation),
            ),
            queryFn: ({ signal }: { signal: AbortSignal }) =>
                viewOperation<ViewBadge | null>(view.viewId, context, 'badge.snapshot', {}, signal),
        })),
    });
    return aggregateContainerBadges(
        views.map((view, index) => ({
            containerId: view.containerId,
            badge: queries[index]?.isError ? undefined : queries[index]?.data,
        })),
    );
}
