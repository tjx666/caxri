import type { ViewCatalogSnapshot } from '@shared/views';
import { describe, expect, it } from 'vitest';

import { getPaletteExtensionCommands } from '../command-palette-commands';

const catalog: ViewCatalogSnapshot = {
    revision: 1,
    containers: [],
    views: [],
    extensions: [],
    commands: [
        {
            id: 'secondarySidebar.searchFiles',
            title: 'Search Files',
            source: { kind: 'extension', extensionId: 'caxri.files' },
            lifecycle: 'active',
        },
        {
            id: 'caxri.files.newFile',
            title: 'New File',
            source: { kind: 'extension', extensionId: 'caxri.files' },
            lifecycle: 'active',
        },
        {
            id: 'secondarySidebar.showGit',
            title: 'Show Git',
            source: { kind: 'builtin' },
            lifecycle: 'builtin',
        },
    ],
};

describe('getPaletteExtensionCommands', () => {
    it('deduplicates extension contributions that already have a static command row', () => {
        expect(getPaletteExtensionCommands(catalog).map(({ id }) => id)).toEqual([
            'caxri.files.newFile',
        ]);
    });

    it('fails closed when the catalog is not available', () => {
        expect(getPaletteExtensionCommands(undefined)).toEqual([]);
    });
});
