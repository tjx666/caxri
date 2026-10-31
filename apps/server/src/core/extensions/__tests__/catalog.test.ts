import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { ExtensionManifest } from '@caxri/protocol';
import { extensionManifestSchema, MAX_VIEW_CATALOG_CONTAINERS } from '@caxri/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { buildViewCatalog } from '../catalog';
import { readExtensionLocalization } from '../localization';

const temporaryDirectories: string[] = [];
const bundledExtensionsRoot = resolve(import.meta.dirname, '../../../../../../extensions');

afterEach(async () => {
    const directories = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
});

async function extension(id: string, containerId: string, icon?: unknown, order?: number) {
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
        contributes: {
            viewsContainers: {
                secondarySidebar: [
                    {
                        id: containerId,
                        title: 'Fixture',
                        ...(order !== undefined && { order }),
                        icon: (icon ?? {
                            kind: 'resource',
                            path: 'media/icon.svg',
                        }) as never,
                    },
                ],
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
        localization: { manifests: { en: manifest }, runtimeBundles: {}, ignoredFiles: [] },
    };
}

function bundledProducts() {
    return Promise.all(
        ['git', 'status'].map(async (name) => {
            const rootPath = join(bundledExtensionsRoot, name);
            const source = await readFile(join(rootPath, 'package.json'), 'utf8');
            const localization = await readExtensionLocalization(
                rootPath,
                extensionManifestSchema.parse(JSON.parse(source)),
            );
            const manifest = localization.manifests.en;
            return {
                extensionId: manifest.name,
                source: 'bundled' as const,
                rootPath,
                entryPath: join(rootPath, 'dist/extension.js'),
                manifest,
                localization,
            };
        }),
    );
}

describe('buildViewCatalog', () => {
    it('registers Files as a typed Workbench Core contribution without builtin-react dispatch', async () => {
        const catalog = await buildViewCatalog({
            extensions: [],
            rejected: [],
            states: new Map(),
            revision: 1,
        });

        expect(catalog.containers.find(({ id }) => id === 'caxri.files')).toMatchObject({
            lifecycle: 'core',
            source: { kind: 'core' },
            title: 'Files',
        });
        expect(catalog.containers.map(({ id }) => id)).not.toContain('caxri.git');
        expect(catalog.views.find(({ id }) => id === 'caxri.files.explorer')).toMatchObject({
            source: { kind: 'core' },
            viewKind: { kind: 'resource-explorer' },
        });
        expect(catalog.extensions.map(({ id }) => id)).not.toContain('caxri.files');
        expect(
            catalog.views.flatMap(({ viewKind }) =>
                viewKind.kind === 'builtin-react' ? [viewKind.component] : [],
            ),
        ).not.toEqual(expect.arrayContaining(['files', 'git']));
    });

    it('catalogs Git and Status as lifecycle-bearing product extensions while Files remains Core', async () => {
        const products = await bundledProducts();
        const states = new Map(
            products.map(({ extensionId }) => [
                extensionId,
                { generation: 7, lifecycle: 'active' as const },
            ]),
        );

        const catalog = await buildViewCatalog({
            extensions: products,
            rejected: [],
            states,
            revision: 1,
        });

        for (const product of products) {
            expect(catalog.extensions).toContainEqual({
                id: product.extensionId,
                version: product.manifest.version,
                generation: 7,
                lifecycle: 'active',
            });
            expect(catalog.containers.find(({ id }) => id === product.extensionId)).toMatchObject({
                source: { kind: 'extension', extensionId: product.extensionId },
                lifecycle: 'active',
            });
        }
        expect(catalog.views.find(({ id }) => id === 'caxri.files.explorer')).toMatchObject({
            source: { kind: 'core' },
            viewKind: { kind: 'resource-explorer' },
        });
        expect(catalog.extensions.map(({ id }) => id)).not.toContain('caxri.files');
        expect(catalog.views.find(({ id }) => id === 'caxri.git.sourceControl')).toMatchObject({
            source: { kind: 'extension', extensionId: 'caxri.git' },
            viewKind: { kind: 'source-control' },
        });
        expect(
            catalog.views.find(({ id }) => id === 'caxri.project-status.overview'),
        ).toMatchObject({
            actions: [
                {
                    commandId: 'caxri.project-status.refresh',
                    role: 'resource.refresh',
                },
            ],
            source: { kind: 'extension', extensionId: 'caxri.project-status' },
            viewKind: { kind: 'tree' },
        });
        expect(catalog.containers.find(({ id }) => id === 'caxri.project-status')).toMatchObject({
            commandId: 'secondarySidebar.showStatus',
        });
        expect(
            catalog.commands.find(({ id }) => id === 'secondarySidebar.showStatus'),
        ).toMatchObject({
            allowInEditable: true,
            title: 'Show Status',
        });
    });

    it('serves bundled extension titles in the interface language with their English source', async () => {
        const products = await bundledProducts();
        const states = new Map(
            products.map(({ extensionId }) => [
                extensionId,
                { generation: 1, lifecycle: 'active' as const },
            ]),
        );
        const options = { extensions: products, rejected: [], states, revision: 1 };

        const english = await buildViewCatalog(options);
        const chinese = await buildViewCatalog({ ...options, locale: 'zh-CN' });

        expect(english.views.find(({ id }) => id === 'caxri.git.sourceControl')).toMatchObject({
            title: 'Source Control',
        });
        expect(english.commands.find(({ id }) => id === 'caxri.git.sync')).not.toHaveProperty(
            'sourceTitle',
        );
        expect(chinese.views.find(({ id }) => id === 'caxri.git.sourceControl')).toMatchObject({
            title: '源代码管理',
        });
        expect(chinese.containers.find(({ id }) => id === 'caxri.project-status')).toMatchObject({
            title: '状态',
        });
        expect(chinese.commands.find(({ id }) => id === 'caxri.git.sync')).toMatchObject({
            title: '同步更改',
            sourceTitle: 'Sync Changes',
        });
        expect(chinese.containers.find(({ id }) => id === 'caxri.git')).toMatchObject({
            title: 'Git',
        });
        expect(
            chinese.commands.find(({ id }) => id === 'secondarySidebar.showStatus'),
        ).toMatchObject({ title: '显示状态', sourceTitle: 'Show Status' });
    });

    it('orders view containers by their manifest contribution instead of discovery order', async () => {
        const status = await extension('publisher.status', 'publisher.status', undefined, 400);
        const files = await extension('publisher.files', 'publisher.files', undefined, 100);
        const fixture = await extension('publisher.fixture', 'publisher.fixture', undefined, 300);
        const git = await extension('publisher.git', 'publisher.git', undefined, 200);

        const catalog = await buildViewCatalog({
            extensions: [status, files, fixture, git],
            rejected: [],
            states: new Map(),
            revision: 1,
        });

        expect(
            catalog.containers
                .filter(({ location }) => location === 'secondarySidebar')
                .map(({ id }) => id),
        ).toEqual([
            // Workbench Core containers interleave with extension ones by `order` rather than forming a block, and win
            // a tie: Files is contributed at 100, so it lands ahead of the extension that shares that order.
            'caxri.files',
            'publisher.files',
            'publisher.git',
            'publisher.fixture',
            'publisher.status',
        ]);
    });

    it('uses one descriptor shape for remaining builtin-react and extension tree views', async () => {
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
                    viewKind: { kind: 'builtin-react', component: 'logs' },
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

    it('preserves an allowlisted builtin icon without reading an extension resource', async () => {
        const fixture = await extension('publisher.fixture', 'publisher.fixture', {
            kind: 'builtin',
            id: 'status',
        });
        await rm(join(fixture.rootPath, 'media/icon.svg'));

        const catalog = await buildViewCatalog({
            extensions: [fixture],
            rejected: [],
            states: new Map(),
            revision: 1,
        });

        expect(catalog.containers.find(({ id }) => id === 'publisher.fixture')?.icon).toEqual({
            kind: 'builtin',
            id: 'status',
        });
    });

    it('rejects a duplicate contribution instead of overwriting the builtin catalog', async () => {
        const fixture = await extension('publisher.fixture', 'caxri.logs');
        const catalog = await buildViewCatalog({
            extensions: [fixture],
            rejected: [],
            states: new Map(),
            revision: 1,
        });

        const extensionState = catalog.extensions.find(({ id }) => id === 'publisher.fixture');
        expect(extensionState?.lifecycle).toBe('error');
        expect(extensionState?.error?.code).toBe('DUPLICATE_ID');
        expect(catalog.containers.filter(({ id }) => id === 'caxri.logs')).toHaveLength(1);
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

    it('isolates an icon whose base64 data URL would exceed the catalog wire bound', async () => {
        const fixture = await extension('publisher.fixture', 'publisher.fixture');
        await writeFile(join(fixture.rootPath, 'media/icon.svg'), Buffer.alloc(96 * 1_024));

        const catalog = await buildViewCatalog({
            extensions: [fixture],
            rejected: [],
            states: new Map(),
            revision: 1,
        });

        expect(catalog.extensions.find(({ id }) => id === 'publisher.fixture')).toMatchObject({
            lifecycle: 'error',
            error: { code: 'MANIFEST_INVALID' },
        });
        expect(catalog.containers.some(({ id }) => id === 'publisher.fixture')).toBe(false);
        expect(
            catalog.containers.find(
                ({ source }) =>
                    source.kind === 'extension' && source.extensionId === 'publisher.fixture',
            ),
        ).toMatchObject({ lifecycle: 'error', error: { code: 'MANIFEST_INVALID' } });
        expect(catalog.containers.some(({ id }) => id === 'caxri.files')).toBe(true);
    });

    it('rejects only the extension that would exceed shared catalog capacity', async () => {
        const fixtures = await Promise.all(
            Array.from({ length: MAX_VIEW_CATALOG_CONTAINERS - 1 }, (_, index) =>
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

    it('surfaces a rejected extension as an isolated error container', async () => {
        const catalog = await buildViewCatalog({
            extensions: [],
            rejected: [
                {
                    extensionId: 'invalid.broken-123456789abc',
                    version: 'unknown',
                    error: { code: 'MANIFEST_INVALID', message: 'package.json is invalid' },
                },
            ],
            states: new Map(),
            revision: 1,
        });

        expect(catalog.containers.find(({ id }) => id === 'invalid.broken-123456789abc')).toEqual(
            expect.objectContaining({
                lifecycle: 'error',
                error: { code: 'MANIFEST_INVALID', message: 'package.json is invalid' },
            }),
        );
        expect(catalog.containers.some(({ id }) => id === 'caxri.files')).toBe(true);
    });
});
