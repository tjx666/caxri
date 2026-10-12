import type { ViewCatalogSnapshot } from '@caxri/protocol';

import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
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
    return viewId ? createResourceExplorerClient(viewId) : undefined;
}

/**
 * Resolves the currently contributed Core Resource Explorer without knowing its product id. Non-panel consumers such as
 * the Path Browser therefore use the same typed client as the controlled surface.
 */
export async function activeResourceExplorerClient(): Promise<ResourceExplorerClient> {
    const client = await resourceExplorerClient();
    if (!client)
        throw Object.assign(new Error(translate('viewContainers.files.providerMissing')), {
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
