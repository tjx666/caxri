import type { ProjectStatusSummary } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { DiscoveredExtension } from '../discovery';
import { grantsForExtension, projectStatusForExtension } from '../host-api-access';

function extension(source: DiscoveredExtension['source']): DiscoveredExtension {
    const manifest: DiscoveredExtension['manifest'] = {
        name: 'publisher.fixture',
        version: '1.0.0',
        type: 'module',
        main: './dist/extension.js',
        engines: { caxri: '^0.0.17' },
        caxri: { capabilities: ['projects.read', 'settings.read'] },
        contributes: {
            viewsContainers: { secondarySidebar: [], panel: [] },
            views: {},
            commands: [],
        },
    };
    return {
        extensionId: 'publisher.fixture',
        source,
        rootPath: '/extensions/fixture',
        entryPath: '/extensions/fixture/dist/extension.js',
        manifest,
        localization: { manifests: { en: manifest }, runtimeBundles: {}, ignoredFiles: [] },
    };
}

describe('ExtensionService capability projection', () => {
    it('records actual grants independently from an installed extension declaration', () => {
        expect(grantsForExtension(extension('bundled'))).toEqual([
            'projects.read',
            'settings.read',
        ]);
        expect(grantsForExtension(extension('installed'))).toEqual([]);
    });

    it('removes Runtime filesystem roots from the extension-facing Project Status projection', () => {
        const summary: ProjectStatusSummary = {
            refreshedAt: 1,
            repositories: [
                {
                    id: 'repository-1',
                    kind: 'primary',
                    name: 'fixture',
                    rootPath: '/private/project',
                    branch: 'main',
                    acceptances: [],
                    linearIssues: [],
                    errors: [],
                },
            ],
        };

        expect(projectStatusForExtension(summary)).toEqual({
            refreshedAt: 1,
            repositories: [
                {
                    id: 'repository-1',
                    kind: 'primary',
                    name: 'fixture',
                    branch: 'main',
                    acceptances: [],
                    linearIssues: [],
                    errors: [],
                },
            ],
        });
    });
});
