import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ExtensionManifest } from '../../../../packages/protocol/src/domain/views';
import { MAX_VIEW_CATALOG_CONTAINERS } from '../../../../packages/protocol/src/domain/views';
import { buildViewCatalog } from '../catalog';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const directories = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
});

async function extension(id: string, containerId: string) {
    const rootPath = await mkdtemp(join(tmpdir(), 'caxri-extension-catalog-'));
    temporaryDirectories.push(rootPath);
    await mkdir(join(rootPath, 'media'));
    await writeFile(join(rootPath, 'media/icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const manifest: ExtensionManifest = {
        name: id,
        version: '1.0.0',
        type: 'module',
        main: './extension.js',
        engines: { caxri: '^0.0.17' },
        caxri: { capabilities: [] },
        activationEvents: [],
        contributes: {
            viewsContainers: {
                secondarySidebar: [{ id: containerId, title: 'Fixture', icon: 'media/icon.svg' }],
                panel: [],
            },
            views: {
                [containerId]: [{ id: `${containerId}.tree`, name: 'Tree', type: 'tree' }],
            },
            commands: [],
        },
    };
    return {
        extensionId: id,
        source: 'bundled' as const,
        rootPath,
        entryPath: join(rootPath, 'extension.js'),
        manifest,
    };
}

describe('buildViewCatalog', () => {
    it('uses one descriptor shape for builtin-react and extension tree views', async () => {
        const fixture = await extension('publisher.fixture', 'publisher.fixture');
        const catalog = await buildViewCatalog({
            extensions: [fixture],
            rejected: [],
            states: new Map([
                ['publisher.fixture', { generation: 1, lifecycle: 'discovered' as const }],
            ]),
            revision: 1,
        });

        expect(catalog.views).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    viewKind: { kind: 'builtin-react', component: 'files' },
                }),
                expect.objectContaining({
                    id: 'publisher.fixture.tree',
                    viewKind: { kind: 'tree' },
                }),
            ]),
        );
        expect(catalog.containers.find(({ id }) => id === 'publisher.fixture')?.icon.kind).toBe(
            'resource',
        );
    });

    it('rejects a duplicate contribution instead of overwriting the builtin catalog', async () => {
        const fixture = await extension('publisher.fixture', 'caxri.files');
        const catalog = await buildViewCatalog({
            extensions: [fixture],
            rejected: [],
            states: new Map(),
            revision: 1,
        });

        const extensionState = catalog.extensions.find(({ id }) => id === 'publisher.fixture');
        expect(extensionState?.lifecycle).toBe('error');
        expect(extensionState?.error?.code).toBe('DUPLICATE_ID');
        expect(catalog.containers.filter(({ id }) => id === 'caxri.files')).toHaveLength(1);
    });

    it('rejects an icon symlink that escapes the canonical extension root', async () => {
        const fixture = await extension('publisher.fixture', 'publisher.fixture');
        const outside = await mkdtemp(join(tmpdir(), 'caxri-extension-icon-outside-'));
        temporaryDirectories.push(outside);
        await writeFile(join(outside, 'secret.svg'), '<svg>secret</svg>');
        await rm(join(fixture.rootPath, 'media/icon.svg'));
        await symlink(join(outside, 'secret.svg'), join(fixture.rootPath, 'media/icon.svg'));

        const catalog = await buildViewCatalog({
            extensions: [fixture],
            rejected: [],
            states: new Map(),
            revision: 1,
        });

        const extensionState = catalog.extensions.find(({ id }) => id === 'publisher.fixture');
        expect(extensionState?.lifecycle).toBe('error');
        expect(extensionState?.error?.code).toBe('MANIFEST_INVALID');
        expect(catalog.containers.some(({ id }) => id === 'publisher.fixture')).toBe(false);
    });

    it('rejects only the extension that would exceed shared catalog capacity', async () => {
        const fixtures = await Promise.all(
            Array.from({ length: MAX_VIEW_CATALOG_CONTAINERS - 3 }, (_, index) =>
                extension(`publisher.fixture-${index}`, `publisher.fixture-${index}`),
            ),
        );
        const catalog = await buildViewCatalog({
            extensions: fixtures,
            rejected: [],
            states: new Map(),
            revision: 1,
        });

        expect(catalog.containers).toHaveLength(MAX_VIEW_CATALOG_CONTAINERS);
        const rejectedExtension = catalog.extensions.at(-1);
        expect(rejectedExtension?.lifecycle).toBe('error');
        expect(rejectedExtension?.error?.code).toBe('PROVIDER_CAPACITY');
        expect(catalog.containers.some(({ id }) => id === rejectedExtension?.id)).toBe(false);
    });
});
