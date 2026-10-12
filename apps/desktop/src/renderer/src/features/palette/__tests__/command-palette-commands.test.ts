import type { ViewCatalogSnapshot } from '@caxri/protocol';
import { commandDefinitions } from '@caxri/protocol';
import { commands as enCommands } from '@desktop-shared/i18n/en/commands';
import { describe, expect, it } from 'vitest';

import type { Translate } from '../../../i18n';
import { terminal as enTerminal } from '../../../i18n/locales/en/terminal';
import {
    getPaletteExtensionCommands,
    getStaticCommandPaletteValue,
    isCommandVisibleInPalette,
    paletteCommandTitle,
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

describe('isCommandVisibleInPalette', () => {
    const localWindow = { localMachine: true, sshHost: false };
    const detach = commandDefinitions.find((command) => command.id === 'session.detach');
    const resume = commandDefinitions.find((command) => command.id === 'session.resume');
    const openPullRequest = commandDefinitions.find(
        (command) => command.id === 'session.openPullRequest',
    );
    const alwaysVisible = commandDefinitions.find((command) => command.id === 'session.create');
    if (!detach || !resume || !openPullRequest || !alwaysVisible) {
        throw new Error('gated commands are missing from the catalog');
    }

    it('shows local-only commands only in a local window and SSH Host commands only in an SSH Host window', () => {
        const processExplorer = commandDefinitions.find(({ id }) => id === 'processExplorer.open');
        const stopServer = commandDefinitions.find(({ id }) => id === 'remote.stopServer');
        const connect = commandDefinitions.find(({ id }) => id === 'remote.connect');
        if (!processExplorer || !stopServer || !connect)
            throw new Error('environment-gated commands are missing from the catalog');
        const session = {
            sessionHasLiveAgent: false,
            sessionHasDetachedAgent: false,
            sessionHasPullRequest: false,
        };
        const sshHostWindow = { ...session, localMachine: false, sshHost: true };
        const local = { ...session, ...localWindow };

        expect(isCommandVisibleInPalette(processExplorer, local)).toBe(true);
        expect(isCommandVisibleInPalette(processExplorer, sshHostWindow)).toBe(false);
        expect(isCommandVisibleInPalette(stopServer, local)).toBe(false);
        expect(isCommandVisibleInPalette(stopServer, sshHostWindow)).toBe(true);
        expect(isCommandVisibleInPalette(connect, local)).toBe(true);
        expect(isCommandVisibleInPalette(connect, sshHostWindow)).toBe(true);
    });

    it('hides gated commands when the current session lacks the matching Agent Terminal', () => {
        const context = {
            sessionHasLiveAgent: false,
            sessionHasDetachedAgent: false,
            sessionHasPullRequest: false,
            ...localWindow,
        };
        expect(isCommandVisibleInPalette(detach, context)).toBe(false);
        expect(isCommandVisibleInPalette(resume, context)).toBe(false);
        expect(isCommandVisibleInPalette(openPullRequest, context)).toBe(false);
        expect(isCommandVisibleInPalette(alwaysVisible, context)).toBe(true);
    });

    it('reveals Open Pull Request only when the current session carries a pull request', () => {
        expect(
            isCommandVisibleInPalette(openPullRequest, {
                sessionHasLiveAgent: false,
                sessionHasDetachedAgent: false,
                sessionHasPullRequest: true,
                ...localWindow,
            }),
        ).toBe(true);
    });

    it('reveals each gated command only when its own predicate matches', () => {
        expect(
            isCommandVisibleInPalette(detach, {
                sessionHasLiveAgent: true,
                sessionHasDetachedAgent: false,
                sessionHasPullRequest: false,
                ...localWindow,
            }),
        ).toBe(true);
        expect(
            isCommandVisibleInPalette(resume, {
                sessionHasLiveAgent: false,
                sessionHasDetachedAgent: true,
                sessionHasPullRequest: false,
                ...localWindow,
            }),
        ).toBe(true);
        expect(
            isCommandVisibleInPalette(detach, {
                sessionHasLiveAgent: false,
                sessionHasDetachedAgent: true,
                sessionHasPullRequest: false,
                ...localWindow,
            }),
        ).toBe(false);
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

describe('paletteCommandTitle', () => {
    const english: Readonly<Record<string, string>> = { ...enCommands, ...enTerminal };
    const t: Translate = (key) => english[key] ?? key;
    const restart = commandDefinitions.find(({ id }) => id === 'terminal.restart');
    const newFile = commandDefinitions.find(({ id }) => id === 'session.create');
    if (!restart || !newFile) throw new Error('commands are missing from the catalog');

    it('names terminal.restart "Restart Agent" when the active Terminal resumes an Agent conversation', () => {
        expect(paletteCommandTitle(restart, { activeTerminalRestartsAgent: true }, t)).toBe(
            'Restart Agent',
        );
    });

    it('keeps "Restart Terminal" for a Shell or no active Terminal', () => {
        expect(paletteCommandTitle(restart, { activeTerminalRestartsAgent: false }, t)).toBe(
            'Restart Terminal',
        );
    });

    it('leaves commands without a resolver on their catalog title in every context', () => {
        expect(paletteCommandTitle(newFile, { activeTerminalRestartsAgent: true }, t)).toBe(
            t('commands.session.create'),
        );
    });
});
