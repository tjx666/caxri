import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach } from 'vitest';

import { disposeAllExtensions } from '../api-factory';
import type { ExtensionHostRegistration } from '../protocol';

/**
 * One throwaway extension root per test, holding a minimal `extension.mjs` whose `activate()` succeeds. Tests that need
 * a different activation body overwrite the file before configuring the extension.
 */
export const fixture = { extensionRoot: '' };

export function installExtensionFixture(): void {
    beforeEach(async () => {
        fixture.extensionRoot = await mkdtemp(join(tmpdir(), 'caxri-extension-api-'));
        await writeFile(
            join(fixture.extensionRoot, 'extension.mjs'),
            'export function activate() {}',
        );
    });

    afterEach(async () => {
        disposeAllExtensions();
        await rm(fixture.extensionRoot, { force: true, recursive: true });
    });
}

export function registration(
    generation = 1,
    viewType: 'source-control' | 'tree' = 'tree',
): ExtensionHostRegistration {
    return {
        extensionId: 'publisher.fixture',
        generation,
        apiToken: `fixture-token-${generation}`,
        rootPath: fixture.extensionRoot,
        entryPath: join(fixture.extensionRoot, 'extension.mjs'),
        grants: ['projects.read'],
        projectIds: ['project-1'],
        l10n: {},
        manifest: {
            name: 'publisher.fixture',
            version: '1.0.0',
            type: 'module',
            main: './extension.mjs',
            engines: { caxri: '^0.0.17' },
            caxri: { capabilities: ['projects.read'] },
            contributes: {
                viewsContainers: {
                    secondarySidebar: [
                        {
                            id: 'publisher.fixture',
                            title: 'Fixture',
                            icon: { kind: 'resource', path: 'fixture.svg' },
                        },
                    ],
                    panel: [],
                },
                views: {
                    'publisher.fixture': [
                        { id: 'publisher.fixture.tree', name: 'Fixture', type: viewType },
                    ],
                },
                commands: [],
            },
        },
    };
}
