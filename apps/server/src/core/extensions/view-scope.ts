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

/**
 * Confirms a view request's scope still names a live Session bound to the same Workbench Root. `resolved` is that
 * Session's own context (`app.sessionContext`), not the focused window's: a phone or a second window may view any
 * Session, so only deletion, hiding, or a Workbench Root change retires the scope.
 */
export function assertViewContextCurrent(
    expected: ExtensionViewEventContext,
    resolved: { sessionId?: string; workbenchProjectId?: string },
): void {
    if (expected.kind === 'no-session') return;
    if (
        expected.sessionId !== resolved.sessionId ||
        expected.workbenchProjectId !== resolved.workbenchProjectId
    )
        throw new CaxriError('CANCELLED', 'Controlled view scope is no longer current');
}
