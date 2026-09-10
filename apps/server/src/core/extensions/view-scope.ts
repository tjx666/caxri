import type { ExtensionViewEventContext, ViewCatalogSnapshot } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { DiscoveredExtension } from './discovery';

export function extensionForView(
    viewId: string,
    catalog: ViewCatalogSnapshot,
    discovered: readonly DiscoveredExtension[],
): DiscoveredExtension {
    const descriptor = catalog.views.find(({ id }) => id === viewId);
    if (descriptor?.source.kind !== 'extension')
        throw Object.assign(new Error(`Extension view not found: ${viewId}`), {
            code: 'PROVIDER_MISSING',
        });
    const extensionId = descriptor.source.extensionId;
    const extension = discovered.find((entry) => entry.extensionId === extensionId);
    if (!extension) throw new Error(`Extension not discovered: ${extensionId}`);
    return extension;
}

export function assertActiveViewContext(
    expected: ExtensionViewEventContext,
    active: { sessionId?: string; workbenchProjectId?: string },
): void {
    if (expected.kind === 'no-session' && !active.sessionId && !active.workbenchProjectId) return;
    if (
        expected.kind !== 'session' ||
        expected.sessionId !== active.sessionId ||
        expected.workbenchProjectId !== active.workbenchProjectId
    )
        throw new CaxriError('CANCELLED', 'Controlled view scope is no longer active');
}
