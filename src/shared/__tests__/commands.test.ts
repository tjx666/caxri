import { describe, expect, it } from 'vitest';

import {
    commandDefinitions,
    defaultKeybindings,
    getNativeMenuCommandGroups,
    nativeMenuIds,
} from '../commands';
import { commandIds } from '../ipc';

describe('command registry', () => {
    it('has unique IDs and owns every default keybinding command', () => {
        const ids = commandDefinitions.map((command) => command.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(commandDefinitions.every((command) => command.description.trim().length > 0)).toBe(
            true,
        );
        expect(new Set(ids)).toEqual(new Set(commandIds));
        expect(
            defaultKeybindings.every((binding) => (ids as string[]).includes(binding.command)),
        ).toBe(true);
        expect(defaultKeybindings).toEqual(
            expect.arrayContaining([
                { key: 'cmd+k', command: 'terminal.clear' },
                { key: 'cmd+f', command: 'terminal.find' },
                { key: 'cmd+[', command: 'primarySidebar.toggle' },
                { key: 'cmd+]', command: 'secondarySidebar.toggle' },
                { key: 'cmd+shift+f', command: 'secondarySidebar.searchFiles' },
                { key: 'cmd+,', command: 'settings.open' },
                { key: 'cmd+shift+p', command: 'commandPalette.open' },
                { key: 'cmd+shift+a', command: 'agentActions.open' },
                { key: 'ctrl+alt+tab', command: 'session.switchMru' },
                { key: 'cmd+t', command: 'terminal.new' },
                { key: 'cmd+w', command: 'workbench.closeActiveTab' },
            ]),
        );
        expect(commandDefinitions).toContainEqual(
            expect.objectContaining({
                id: 'developer.toggleScreencastMode',
                title: 'Toggle Screencast Mode',
                category: 'Developer',
            }),
        );
        expect(commandDefinitions).toContainEqual(
            expect.objectContaining({
                id: 'developer.reportBug',
                title: 'Report Bug to Agent',
                category: 'Developer',
            }),
        );
    });

    it('owns unique native-menu placements and returns them in presentation order', () => {
        const placements = commandDefinitions.flatMap((command) =>
            command.nativeMenu ? [{ command: command.id, ...command.nativeMenu }] : [],
        );
        const slots = placements.map(({ menu, group, order }) => `${menu}:${group}:${order}`);

        expect(new Set(slots).size).toBe(slots.length);
        expect(
            placements.every(
                ({ menu, group, order }) =>
                    nativeMenuIds.includes(menu) &&
                    Number.isSafeInteger(group) &&
                    group >= 0 &&
                    Number.isSafeInteger(order) &&
                    order >= 0,
            ),
        ).toBe(true);
        expect(
            getNativeMenuCommandGroups('session').map((group) =>
                group.map((command) => command.id),
            ),
        ).toEqual([
            ['session.create', 'session.delete'],
            ['session.selectPrevious', 'session.selectNext'],
            ['session.navigateBack', 'session.navigateForward'],
        ]);
    });

    it('defines builtin chrome commands while extension commands remain Host-catalog data', () => {
        expect(commandDefinitions.map(({ id }) => id)).toEqual(
            expect.arrayContaining([
                'secondarySidebar.showFiles',
                'secondarySidebar.showGit',
                'panel.showLogs',
                'panel.showInfo',
            ]),
        );
        expect(commandDefinitions.some(({ id }) => id.startsWith('viewContainers.show.'))).toBe(
            false,
        );
    });
});
