import type { ViewCatalogSnapshot } from '@shared/views';

import { caxri } from '../../lib/caxri';
import type { ResourceExplorerClient } from './view-operation-client';
import { createResourceExplorerClient } from './view-operation-client';

export function availableResourceExplorerViewId(
    catalog: Pick<ViewCatalogSnapshot, 'extensions' | 'views'>,
): string | undefined {
    return catalog.views.find((view) => {
        if (view.viewKind.kind !== 'resource-explorer') return false;
        if (view.source.kind !== 'extension') return true;
        const extensionId = view.source.extensionId;
        const extension = catalog.extensions.find(({ id }) => id === extensionId);
        return (
            extension !== undefined &&
            extension.lifecycle !== 'crashed' &&
            extension.lifecycle !== 'disabled' &&
            extension.lifecycle !== 'error'
        );
    })?.id;
}

async function resourceExplorerClient(): Promise<ResourceExplorerClient | undefined> {
    const catalog = await caxri.request('viewContainers.catalog', {});
    const viewId = availableResourceExplorerViewId(catalog);
    return viewId ? createResourceExplorerClient(viewId) : undefined;
}

/**
 * Resolves the currently contributed Resource Explorer without knowing a product extension id. Non-panel consumers such
 * as the Path Browser therefore use the same controlled provider instead of retaining a second Renderer-to-files
 * implementation.
 */
export async function activeResourceExplorerClient(): Promise<ResourceExplorerClient> {
    const client = await resourceExplorerClient();
    if (!client)
        throw Object.assign(new Error('No Resource Explorer provider is available'), {
            code: 'PROVIDER_MISSING',
        });
    return client;
}

/**
 * Startup and crash recovery wait for a later catalog event instead of surfacing normal unavailability as a fault.
 */
export function availableResourceExplorerClient(): Promise<ResourceExplorerClient | undefined> {
    return resourceExplorerClient();
}
