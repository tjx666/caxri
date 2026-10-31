import type { AppSettings, ExtensionCapability, ProjectStatusSummary } from '@caxri/protocol';

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
 * A setting read through `workspace.getConfiguration`, limited to keys the extension's views list in
 * `configurationDependencies`. Access is checked again after the read, since the generation can retire meanwhile.
 */
export async function readDeclaredConfig(options: {
    assertAccess(): void;
    discovered: readonly DiscoveredExtension[];
    extensionId: string;
    key: string;
    settings(): Promise<AppSettings> | undefined;
}): Promise<unknown> {
    const { key } = options;
    options.assertAccess();
    const extension = options.discovered.find(
        ({ extensionId }) => extensionId === options.extensionId,
    );
    const declared = Object.values(extension?.manifest.contributes.views ?? {})
        .flat()
        .some((view) => view.configurationDependencies?.includes(key));
    if (!declared)
        throw Object.assign(new Error('Extension configuration key is not declared'), {
            code: 'CAPABILITY_DENIED',
        });
    const settings = await options.settings();
    if (!settings)
        throw Object.assign(new Error('Extension configuration is unavailable'), {
            code: 'EXTENSION_HOST_UNAVAILABLE',
        });
    options.assertAccess();
    if (!Object.hasOwn(settings, key))
        throw Object.assign(new Error('Extension configuration key is unknown'), {
            code: 'CAPABILITY_DENIED',
        });
    return settings[key as keyof AppSettings];
}

/**
 * The Project Status an extension reads outside any Session.
 */
export function projectStatusWithoutSession(): ExtensionProjectStatusSummary {
    return { repositories: [], refreshedAt: Date.now(), error: 'No active Session' };
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
