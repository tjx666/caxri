import { describe, expect, it } from 'vitest';

import {
    extensionManifestSchema,
    extensionTreeViewStatesSchema,
    treeItemSchema,
    viewCatalogSnapshotSchema,
    viewContainerIdSchema,
} from '../views';

describe('extension view contracts', () => {
    it('bounds stable tree identity and persisted per-view state', () => {
        expect(
            treeItemSchema.parse({
                handle: 'id:repository',
                id: 'repository',
                label: 'Repository',
                accessibilityLabel: 'Repository',
                collapsibleState: 'expanded',
            }),
        ).toMatchObject({ id: 'repository' });
        expect(
            treeItemSchema.safeParse({
                handle: 'id:oversized',
                id: 'x'.repeat(481),
                label: 'Oversized',
                accessibilityLabel: 'Oversized',
                collapsibleState: 'none',
            }).success,
        ).toBe(false);
        expect(
            extensionTreeViewStatesSchema.safeParse({
                'publisher.fixture.tree': {
                    expandedItemIds: ['repository'],
                    initializedItemIds: ['repository'],
                    focusedItemId: 'repository',
                },
            }).success,
        ).toBe(true);
    });

    it('keeps unknown namespaced ViewContainer ids as bounded strings', () => {
        expect(viewContainerIdSchema.parse('publisher.experimental-view')).toBe(
            'publisher.experimental-view',
        );
        expect(viewContainerIdSchema.safeParse(' bad id ').success).toBe(false);
        expect(viewContainerIdSchema.safeParse('x'.repeat(201)).success).toBe(false);
    });

    it('accepts only ESM extension entries and the supported contribution locations', () => {
        const manifest = extensionManifestSchema.parse({
            name: 'caxri.fixture',
            version: '1.0.0',
            type: 'module',
            main: './dist/extension.js',
            engines: { caxri: '^0.0.17' },
            caxri: { capabilities: ['projects.read'] },
            contributes: {
                viewsContainers: {
                    secondarySidebar: [
                        {
                            id: 'caxri.fixture',
                            title: 'Fixture',
                            icon: { kind: 'resource', path: 'media/fixture.svg' },
                        },
                    ],
                },
                views: {
                    'caxri.fixture': [{ id: 'caxri.fixture.tree', name: 'Fixture', type: 'tree' }],
                },
            },
        });
        expect(manifest.contributes.viewsContainers.panel).toEqual([]);

        expect(
            extensionManifestSchema.safeParse({
                ...manifest,
                type: 'commonjs',
                main: './dist/extension.cjs',
            }).success,
        ).toBe(false);
        for (const path of ['../secret.svg', '/tmp/secret.svg', 'media/icon.js'])
            expect(
                extensionManifestSchema.safeParse({
                    ...manifest,
                    contributes: {
                        ...manifest.contributes,
                        viewsContainers: {
                            secondarySidebar: [
                                {
                                    id: 'caxri.fixture',
                                    title: 'Fixture',
                                    icon: { kind: 'resource', path },
                                },
                            ],
                            panel: [],
                        },
                    },
                }).success,
            ).toBe(false);
    });

    it('accepts only explicit resource and allowlisted builtin container icons', () => {
        const manifest = {
            name: 'caxri.fixture',
            version: '1.0.0',
            type: 'module',
            main: './dist/extension.js',
            engines: { caxri: '^0.0.17' },
            caxri: { capabilities: [] },
            contributes: {
                viewsContainers: {
                    secondarySidebar: [
                        {
                            id: 'caxri.fixture',
                            title: 'Fixture',
                            icon: { kind: 'builtin', id: 'status' },
                        },
                    ],
                },
            },
        };

        expect(extensionManifestSchema.safeParse(manifest).success).toBe(true);
        expect(
            extensionManifestSchema.safeParse({
                ...manifest,
                contributes: {
                    viewsContainers: {
                        secondarySidebar: [
                            {
                                id: 'caxri.fixture',
                                title: 'Fixture',
                                icon: { kind: 'builtin', id: 'arbitrary-lucide-name' },
                            },
                        ],
                    },
                },
            }).success,
        ).toBe(false);
    });

    it('rejects manifest fields that have no runtime consumer', () => {
        const manifest = {
            name: 'caxri.fixture',
            version: '1.0.0',
            type: 'module',
            main: './dist/extension.js',
            engines: { caxri: '^0.0.17' },
            caxri: { capabilities: [] },
            contributes: {
                views: {
                    'caxri.fixture': [{ id: 'caxri.fixture.tree', name: 'Fixture', type: 'tree' }],
                },
            },
        };

        expect(
            extensionManifestSchema.safeParse({ ...manifest, activationEvents: ['*'] }).success,
        ).toBe(false);
        expect(
            extensionManifestSchema.safeParse({
                ...manifest,
                contributes: {
                    views: {
                        'caxri.fixture': [
                            {
                                id: 'caxri.fixture.tree',
                                name: 'Fixture',
                                type: 'tree',
                                when: 'never',
                            },
                        ],
                    },
                },
            }).success,
        ).toBe(false);
    });

    it('reserves enough container-id capacity for the generated show command', () => {
        const manifest = {
            name: 'caxri.fixture',
            version: '1.0.0',
            type: 'module',
            main: './dist/extension.js',
            engines: { caxri: '^0.0.17' },
            caxri: { capabilities: [] },
            contributes: {
                viewsContainers: {
                    secondarySidebar: [
                        {
                            id: `publisher.${'x'.repeat(190)}`,
                            title: 'Fixture',
                            icon: { kind: 'builtin', id: 'status' },
                        },
                    ],
                },
            },
        };

        expect(extensionManifestSchema.safeParse(manifest).success).toBe(false);
    });

    it('validates one unified builtin and extension catalog shape', () => {
        expect(
            viewCatalogSnapshotSchema.parse({
                revision: 1,
                containers: [
                    {
                        id: 'caxri.files',
                        location: 'secondarySidebar',
                        source: { kind: 'builtin' },
                        title: 'Files',
                        icon: { kind: 'builtin', id: 'files' },
                        commandId: 'secondarySidebar.showFiles',
                        lifecycle: 'builtin',
                    },
                    {
                        id: 'caxri.fixture',
                        location: 'secondarySidebar',
                        source: { kind: 'extension', extensionId: 'caxri.fixture' },
                        title: 'Fixture',
                        icon: { kind: 'theme', id: 'beaker' },
                        commandId: 'caxri.fixture.show',
                        lifecycle: 'discovered',
                    },
                ],
                views: [],
                commands: [],
                extensions: [
                    {
                        id: 'caxri.fixture',
                        version: '1.0.0',
                        generation: 0,
                        lifecycle: 'discovered',
                    },
                ],
            }).containers,
        ).toHaveLength(2);
    });
});
