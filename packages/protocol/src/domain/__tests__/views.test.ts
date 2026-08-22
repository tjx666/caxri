import { describe, expect, it } from 'vitest';

import {
    extensionManifestSchema,
    viewCatalogSnapshotSchema,
    viewContainerIdSchema,
} from '../views';

describe('extension view contracts', () => {
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
                        { id: 'caxri.fixture', title: 'Fixture', icon: 'media/fixture.svg' },
                    ],
                },
                views: {
                    'caxri.fixture': [{ id: 'caxri.fixture.tree', name: 'Fixture', type: 'tree' }],
                },
            },
        });
        expect(manifest.activationEvents).toEqual([]);
        expect(manifest.contributes.viewsContainers.panel).toEqual([]);

        expect(
            extensionManifestSchema.safeParse({
                ...manifest,
                type: 'commonjs',
                main: './dist/extension.cjs',
            }).success,
        ).toBe(false);
        for (const icon of ['../secret.svg', '/tmp/secret.svg', 'media/icon.js'])
            expect(
                extensionManifestSchema.safeParse({
                    ...manifest,
                    contributes: {
                        ...manifest.contributes,
                        viewsContainers: {
                            secondarySidebar: [{ id: 'caxri.fixture', title: 'Fixture', icon }],
                            panel: [],
                        },
                    },
                }).success,
            ).toBe(false);
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
