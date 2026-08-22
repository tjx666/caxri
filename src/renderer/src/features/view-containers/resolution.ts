import type {
    ViewCatalogSnapshot,
    ViewContainerDescriptor,
    ViewContainerId,
    ViewContainerLocation,
} from '@shared/views';

function isResolvable(container: ViewContainerDescriptor): boolean {
    return ['builtin', 'discovered', 'activating', 'active', 'error'].includes(container.lifecycle);
}

/**
 * Resolves presentation without mutating durable intent. Missing, disabled, and crashed extensions fall back only for
 * the current catalog revision. Failed extensions remain selected because their error surface owns the Retry action.
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
