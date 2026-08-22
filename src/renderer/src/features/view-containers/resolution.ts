import type {
    ViewCatalogSnapshot,
    ViewContainerDescriptor,
    ViewContainerId,
    ViewContainerLocation,
} from '@shared/views';

function isResolvable(container: ViewContainerDescriptor): boolean {
    return ['builtin', 'discovered', 'activating', 'active'].includes(container.lifecycle);
}

/**
 * Resolves presentation without mutating durable intent. A missing, disabled, crashed, or failed extension falls back
 * only for the current catalog revision; when its descriptor becomes healthy again the same desired ID rebinds.
 */
export function resolveViewContainerId(
    desiredId: ViewContainerId,
    location: ViewContainerLocation,
    catalog: ViewCatalogSnapshot,
): ViewContainerId | undefined {
    const candidates = catalog.containers.filter(
        (container) => container.location === location && isResolvable(container),
    );
    return candidates.find(({ id }) => id === desiredId)?.id ?? candidates[0]?.id;
}
