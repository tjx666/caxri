import type { ViewCatalogSnapshot } from '@caxri/protocol';
import { commandDefinitions } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    getPaletteExtensionCommands,
    getStaticCommandPaletteValue,
} from '../command-palette-commands';

const catalog: ViewCatalogSnapshot = {
    revision: 1,
    containers: [],
    views: [],
    extensions: [],
    commands: [
        {
            id: 'secondarySidebar.searchFiles',
            title: 'Search Files',
            source: { kind: 'core' },
            lifecycle: 'core',
        },
        {
            id: 'secondarySidebar.newFile',
            title: 'New File',
            source: { kind: 'core' },
            lifecycle: 'core',
        },
        {
            id: 'publisher.fixture.action',
            title: 'Fixture Action',
            source: { kind: 'extension', extensionId: 'publisher.fixture' },
            lifecycle: 'active',
        },
        {
            id: 'publisher.fixture.contextAction',
            title: 'Fixture Context Action',
            palette: false,
            source: { kind: 'extension', extensionId: 'publisher.fixture' },
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
    it('returns palette-visible Core and extension contributions without static duplicates', () => {
        expect(getPaletteExtensionCommands(catalog).map(({ id }) => id)).toEqual([
            'secondarySidebar.newFile',
            'publisher.fixture.action',
        ]);
    });

    it('fails closed when the catalog is not available', () => {
        expect(getPaletteExtensionCommands(undefined)).toEqual([]);
    });
});

describe('getStaticCommandPaletteValue', () => {
    it('makes Agent Commands & Skills discoverable through natural and legacy terms', () => {
        const command = commandDefinitions.find(({ id }) => id === 'agentActions.open');
        if (!command) throw new Error('agentActions.open is missing from the command catalog');

        const value = getStaticCommandPaletteValue(command).toLowerCase();
        for (const term of ['command', 'commands', 'skill', 'skills', 'slash', 'action']) {
            expect(value).toContain(term);
        }
    });
});
