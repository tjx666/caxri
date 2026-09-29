import { describe, expect, it } from 'vitest';

import { extensionManifestSchema } from '../extension-manifest';

describe('extension manifest contract', () => {
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

        const orderedManifest = extensionManifestSchema.parse({
            ...manifest,
            contributes: {
                ...manifest.contributes,
                viewsContainers: {
                    secondarySidebar: [
                        {
                            ...manifest.contributes.viewsContainers.secondarySidebar[0],
                            order: 200,
                        },
                    ],
                },
            },
        });
        expect(orderedManifest.contributes.viewsContainers.secondarySidebar[0].order).toBe(200);
        for (const order of [-1, 1.5, 10_001])
            expect(
                extensionManifestSchema.safeParse({
                    ...orderedManifest,
                    contributes: {
                        ...orderedManifest.contributes,
                        viewsContainers: {
                            secondarySidebar: [
                                {
                                    ...orderedManifest.contributes.viewsContainers
                                        .secondarySidebar[0],
                                    order,
                                },
                            ],
                        },
                    },
                }).success,
            ).toBe(false);

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

    it('keeps semantic toolbar roles on Workbench Core resource views', () => {
        const manifest = {
            name: 'caxri.fixture',
            version: '1.0.0',
            type: 'module',
            main: './dist/extension.js',
            engines: { caxri: '^0.0.17' },
            caxri: { capabilities: ['git.read'] },
            contributes: {
                views: {
                    'caxri.fixture': [
                        {
                            id: 'caxri.fixture.sourceControl',
                            name: 'Source Control',
                            type: 'source-control',
                        },
                    ],
                },
                commands: [
                    {
                        command: 'caxri.fixture.refresh',
                        title: 'Refresh',
                        allowInEditable: true,
                    },
                ],
            },
        };

        expect(extensionManifestSchema.safeParse(manifest).success).toBe(true);
        expect(
            extensionManifestSchema.safeParse({
                ...manifest,
                contributes: {
                    ...manifest.contributes,
                    views: {
                        'caxri.fixture': [
                            {
                                ...manifest.contributes.views['caxri.fixture'][0],
                                type: 'resource-explorer',
                            },
                        ],
                    },
                },
            }).success,
        ).toBe(false);
        expect(
            extensionManifestSchema.safeParse({
                ...manifest,
                contributes: {
                    ...manifest.contributes,
                    views: {
                        'caxri.fixture': [
                            {
                                ...manifest.contributes.views['caxri.fixture'][0],
                                actions: [
                                    {
                                        command: 'caxri.fixture.refresh',
                                        role: 'source.refresh',
                                    },
                                ],
                            },
                        ],
                    },
                },
            }).success,
        ).toBe(false);
    });

    it('accepts only the refresh toolbar role on extension tree views', () => {
        const manifest = {
            name: 'caxri.fixture',
            version: '1.0.0',
            type: 'module',
            main: './dist/extension.js',
            engines: { caxri: '^0.0.17' },
            caxri: { capabilities: [] },
            contributes: {
                views: {
                    'caxri.fixture': [
                        {
                            id: 'caxri.fixture.tree',
                            name: 'Fixture',
                            type: 'tree',
                            actions: [
                                {
                                    command: 'caxri.fixture.refresh',
                                    role: 'resource.refresh',
                                },
                            ],
                        },
                    ],
                },
                commands: [{ command: 'caxri.fixture.refresh', title: 'Refresh' }],
            },
        };

        expect(extensionManifestSchema.safeParse(manifest).success).toBe(true);
        expect(
            extensionManifestSchema.safeParse({
                ...manifest,
                contributes: {
                    ...manifest.contributes,
                    views: {
                        'caxri.fixture': [
                            {
                                ...manifest.contributes.views['caxri.fixture'][0],
                                actions: [
                                    {
                                        command: 'caxri.fixture.refresh',
                                        role: 'resource.createFile',
                                    },
                                ],
                            },
                        ],
                    },
                },
            }).success,
        ).toBe(false);
    });

    it('requires settings.read for declared controlled-view configuration dependencies', () => {
        const manifest = {
            name: 'caxri.fixture',
            version: '1.0.0',
            type: 'module',
            main: './dist/extension.js',
            engines: { caxri: '^0.0.18' },
            caxri: { capabilities: ['settings.read'] },
            contributes: {
                views: {
                    'caxri.fixture': [
                        {
                            id: 'caxri.fixture.sourceControl',
                            name: 'Source Control',
                            type: 'source-control',
                            configurationDependencies: ['git.fetchGitHubAvatars'],
                        },
                    ],
                },
            },
        };

        expect(extensionManifestSchema.safeParse(manifest).success).toBe(true);
        expect(
            extensionManifestSchema.safeParse({
                ...manifest,
                caxri: { capabilities: [] },
            }).success,
        ).toBe(false);
    });
});
