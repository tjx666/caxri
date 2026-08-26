import type { ViewCatalogSnapshot } from '@caxri/protocol';

import { caxri } from '../../lib/caxri';
import { getSelectedSession } from '../../stores/selectors';
import type { ResourceExplorerClient } from './resource-explorer/resource-explorer-client';
import { createResourceExplorerClient } from './resource-explorer/resource-explorer-client';

export function availableResourceExplorerViewId(
    catalog: Pick<ViewCatalogSnapshot, 'extensions' | 'views'>,
): string | undefined {
    return catalog.views.find(
        (view) => view.viewKind.kind === 'resource-explorer' && view.source.kind === 'core',
    )?.id;
}

async function resourceExplorerClient(): Promise<ResourceExplorerClient | undefined> {
    const catalog = await caxri.request('viewContainers.catalog', {});
    const viewId = availableResourceExplorerViewId(catalog);
    const session = getSelectedSession();
    return viewId ? createResourceExplorerClient(viewId, session?.id) : undefined;
}

/**
 * Resolves the currently contributed Core Resource Explorer without knowing its product id. Non-panel consumers such as
 * the Path Browser therefore use the same typed client as the controlled surface.
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
 * Startup recovery waits for the Core catalog instead of surfacing normal unavailability as a fault.
 */
export function availableResourceExplorerClient(): Promise<ResourceExplorerClient | undefined> {
    return resourceExplorerClient();
}
