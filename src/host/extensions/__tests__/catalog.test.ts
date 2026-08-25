import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it } from 'vitest';

import type { ExtensionManifest } from '../../../../packages/protocol/src/domain/views';
import {
    extensionManifestSchema,
    MAX_VIEW_CATALOG_CONTAINERS,
} from '../../../../packages/protocol/src/domain/views';
import { buildViewCatalog } from '../catalog';

const temporaryDirectories: string[] = [];

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
    };
}

describe('buildViewCatalog', () => {
    it('does not register Files or Git through the builtin catalog', async () => {
        const catalog = await buildViewCatalog({
            extensions: [],
            rejected: [],
            states: new Map(),
            revision: 1,
        });

        expect(catalog.containers.map(({ id }) => id)).not.toContain('caxri.files');
        expect(catalog.containers.map(({ id }) => id)).not.toContain('caxri.git');
        expect(
            catalog.views.flatMap(({ viewKind }) =>
                viewKind.kind === 'builtin-react' ? [viewKind.component] : [],
            ),
        ).not.toEqual(expect.arrayContaining(['files', 'git']));
    });

    it('catalogs Files and Git only as lifecycle-bearing product extensions', async () => {
        const products = await Promise.all(
            ['files', 'git'].map(async (name) => {
                const rootPath = join(process.cwd(), 'extensions', name);
                const source = await readFile(join(rootPath, 'package.json'), 'utf8');
                const manifest = extensionManifestSchema.parse(JSON.parse(source));
                return {
                    extensionId: manifest.name,
                    source: 'bundled' as const,
                    rootPath,
                    entryPath: join(rootPath, 'dist/extension.js'),
                    manifest,
                };
            }),
        );
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
            source: { kind: 'extension', extensionId: 'caxri.files' },
            viewKind: { kind: 'resource-explorer' },
        });
        expect(catalog.views.find(({ id }) => id === 'caxri.git.sourceControl')).toMatchObject({
            source: { kind: 'extension', extensionId: 'caxri.git' },
            viewKind: { kind: 'source-control' },
        });
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
        ).toEqual(['publisher.files', 'publisher.git', 'publisher.fixture', 'publisher.status']);
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
        expect(catalog.containers.some(({ id }) => id === 'caxri.files')).toBe(false);
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
        expect(catalog.containers.some(({ id }) => id === 'caxri.files')).toBe(false);
    });
});
