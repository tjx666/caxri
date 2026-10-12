import type { ExtensionCapability, ProjectStatusSummary } from '@caxri/protocol';

import type { ExtensionProjectStatusSummary } from '../../extension-host/protocol';
import type { DiscoveredExtension } from './discovery';

/**
 * Project Status as an Extension may see it: repository root paths stay inside Server Core.
 */
export function projectStatusForExtension(
    summary: ProjectStatusSummary,
): ExtensionProjectStatusSummary {
    return {
        ...summary,
        repositories: summary.repositories.map((repo) => {
            const projected = { ...repo };
            Reflect.deleteProperty(projected, 'rootPath');
            return projected;
        }),
    };
}

/**
 * Bundled Extensions receive their declared capabilities; installed Extensions receive none.
 */
export function grantsForExtension(extension: DiscoveredExtension): ExtensionCapability[] {
    return extension.source === 'bundled' ? extension.manifest.caxri.capabilities : [];
}

/**
 * Authority actually recorded for one Extension generation. Declarations in a manifest do not become authority until
 * `ExtensionService` records them here.
 */
export interface ExtensionGrant {
    apiToken: string;
    capabilities: Set<ExtensionCapability>;
    projectIds: Set<string>;
}
