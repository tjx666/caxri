import type { ViewCatalogSnapshot } from '@caxri/protocol';
import { commandDefinitions } from '@caxri/protocol';
import { commands as enCommands } from '@desktop-shared/i18n/en/commands';
import { describe, expect, it } from 'vitest';

import type { Translate } from '../../../i18n';
import { terminal as enTerminal } from '../../../i18n/locales/en/terminal';
import {
    commanderPaletteWhenContext,
    getPaletteExtensionCommands,
    isCommandVisibleInPalette,
    paletteCommandTitle,
    staticCommandSearchEntry,
} from '../command-palette-commands';
import { paletteSearchScore } from '../palette-search';

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
    const noChat = {
        agentChatModels: false,
        agentChatPermissionModes: false,
        agentChatPlanMode: false,
        agentChatSideChat: false,
        agentChatWaiting: false,
        pinnedSessions: false,
    };
    const localWindow = {
        commanderHandOverAvailable: true,
        commanderTakeBackAvailable: false,
        localMachine: true,
        sshHost: false,
        ...noChat,
    };
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
        const stopServer = commandDefinitions.find(({ id }) => id === 'sshHost.stopServer');
        const connect = commandDefinitions.find(({ id }) => id === 'sshHost.connect');
        if (!processExplorer || !stopServer || !connect)
            throw new Error('environment-gated commands are missing from the catalog');
        const session = {
            sessionHasLiveAgent: false,
            sessionHasDetachedAgent: false,
            sessionHasPullRequest: false,
        };
        const sshHostWindow = {
            ...session,
            ...noChat,
            commanderHandOverAvailable: false,
            commanderTakeBackAvailable: false,
            localMachine: false,
            sshHost: true,
        };
        const local = { ...session, ...localWindow };

        expect(isCommandVisibleInPalette(processExplorer, local)).toBe(true);
        expect(isCommandVisibleInPalette(processExplorer, sshHostWindow)).toBe(false);
        expect(isCommandVisibleInPalette(stopServer, local)).toBe(false);
        expect(isCommandVisibleInPalette(stopServer, sshHostWindow)).toBe(true);
        expect(isCommandVisibleInPalette(connect, local)).toBe(true);
        expect(isCommandVisibleInPalette(connect, sshHostWindow)).toBe(true);
    });

    it('offers each Chat composer command only while the active Chat offers its control', () => {
        const session = {
            sessionHasLiveAgent: true,
            sessionHasDetachedAgent: false,
            sessionHasPullRequest: false,
        };
        const chatCommands = {
            agentChatModels: 'agentChat.changeModel',
            agentChatPermissionModes: 'agentChat.changePermissionMode',
            agentChatPlanMode: 'agentChat.togglePlanMode',
            agentChatSideChat: 'agentChat.openSideChat',
            agentChatWaiting: 'agentChat.focusWaitingRequest',
        } as const;
        for (const [predicate, id] of Object.entries(chatCommands)) {
            const command = commandDefinitions.find((definition) => definition.id === id);
            if (!command) throw new Error(`${id} is missing from the catalog`);
            expect(isCommandVisibleInPalette(command, { ...session, ...localWindow })).toBe(false);
            expect(
                isCommandVisibleInPalette(command, {
                    ...session,
                    ...localWindow,
                    [predicate]: true,
                }),
            ).toBe(true);
        }
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

describe('commanderPaletteWhenContext', () => {
    const handOver = commandDefinitions.find(({ id }) => id === 'agentCommander.handOver');
    const takeBack = commandDefinitions.find(({ id }) => id === 'agentCommander.takeBack');
    if (!handOver || !takeBack) throw new Error('Commander commands are missing from the catalog');
    const visible = (context: ReturnType<typeof commanderPaletteWhenContext>) => {
        const full = {
            ...context,
            agentChatModels: false,
            agentChatPermissionModes: false,
            agentChatPlanMode: false,
            agentChatSideChat: false,
            agentChatWaiting: false,
            localMachine: true,
            pinnedSessions: false,
            sessionHasDetachedAgent: false,
            sessionHasLiveAgent: false,
            sessionHasPullRequest: false,
            sshHost: false,
        };
        return [handOver, takeBack]
            .filter((command) => isCommandVisibleInPalette(command, full))
            .map(({ id }) => id);
    };

    it('offers Hand Over for a Session the Commander does not manage, and Take Back once it does', () => {
        expect(
            visible(
                commanderPaletteWhenContext({
                    isLocalOnlyAvailable: true,
                    managedSessionIds: ['other'],
                    selectedSessionId: 'selected',
                }),
            ),
        ).toEqual(['agentCommander.handOver']);
        expect(
            visible(
                commanderPaletteWhenContext({
                    isLocalOnlyAvailable: true,
                    managedSessionIds: ['other', 'selected'],
                    selectedSessionId: 'selected',
                }),
            ),
        ).toEqual(['agentCommander.takeBack']);
    });

    it('offers Hand Over with no Session selected or before the managed set is read', () => {
        expect(
            visible(
                commanderPaletteWhenContext({
                    isLocalOnlyAvailable: true,
                    managedSessionIds: ['other'],
                    selectedSessionId: undefined,
                }),
            ),
        ).toEqual(['agentCommander.handOver']);
        expect(
            visible(
                commanderPaletteWhenContext({
                    isLocalOnlyAvailable: true,
                    managedSessionIds: undefined,
                    selectedSessionId: 'selected',
                }),
            ),
        ).toEqual(['agentCommander.handOver']);
    });

    it('offers neither in an SSH Host window', () => {
        expect(
            visible(
                commanderPaletteWhenContext({
                    isLocalOnlyAvailable: false,
                    managedSessionIds: ['selected'],
                    selectedSessionId: 'selected',
                }),
            ),
        ).toEqual([]);
    });
});

describe('staticCommandSearchEntry', () => {
    it('makes Agent Commands & Skills discoverable through natural and legacy terms', () => {
        const command = commandDefinitions.find(({ id }) => id === 'agentActions.open');
        if (!command) throw new Error('agentActions.open is missing from the command catalog');

        const entry = staticCommandSearchEntry(command);
        for (const term of ['command', 'commands', 'skill', 'skills', 'slash', 'action']) {
            expect(paletteSearchScore(entry, term)).toBeGreaterThan(0);
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
