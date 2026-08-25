import type {
    ViewCatalogSnapshot,
    ViewContainerDescriptor,
    ViewContainerId,
    ViewContainerLocation,
} from '@shared/views';

function isResolvable(container: ViewContainerDescriptor): boolean {
    return ['builtin', 'core', 'discovered', 'activating', 'active'].includes(container.lifecycle);
}

/**
 * Resolves presentation without mutating durable intent. A missing, disabled, crashed, or failed extension falls back
 * only for the current catalog revision; when its descriptor becomes healthy again the same desired ID rebinds.
 */
export function resolveViewContainerId(
    desiredId: ViewContainerId | undefined,
    location: ViewContainerLocation,
    catalog: ViewCatalogSnapshot,
): ViewContainerId | undefined {
    const desired = catalog.containers.find(
        (container) => container.location === location && container.id === desiredId,
    );
    if (desired && (isResolvable(desired) || desired.error)) return desired.id;
    const candidate = catalog.containers.find(
        (container) => container.location === location && isResolvable(container),
    );
    return candidate?.id;
}
