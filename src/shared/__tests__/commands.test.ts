import { describe, expect, it } from 'vitest';

import {
    commandDefinitions,
    defaultKeybindings,
    getNativeMenuCommandGroups,
    nativeMenuIds,
} from '../commands';
import { inspectorModeRegistrations } from '../inspector';

describe('command registry', () => {
    it('has unique IDs and owns every default keybinding command', () => {
        const ids = commandDefinitions.map((command) => command.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(commandDefinitions.every((command) => command.description.trim().length > 0)).toBe(
            true,
        );
        expect(defaultKeybindings.every((binding) => ids.includes(binding.command))).toBe(true);
        expect(defaultKeybindings).toEqual(
            expect.arrayContaining([
                { key: 'cmd+k', command: 'terminal.clear' },
                { key: 'cmd+[', command: 'sidebar.toggle' },
                { key: 'cmd+]', command: 'inspector.toggle' },
                { key: 'cmd+shift+f', command: 'inspector.searchFiles' },
                { key: 'cmd+,', command: 'settings.open' },
                { key: 'cmd+shift+p', command: 'commandPalette.open' },
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
                    Number.isInteger(group) &&
                    group >= 0 &&
                    Number.isInteger(order) &&
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
        ]);
    });

    it('derives every Inspector command and default binding from its mode registration', () => {
        for (const registration of inspectorModeRegistrations) {
            expect(commandDefinitions).toContainEqual(
                expect.objectContaining({
                    id: registration.commandId,
                    title: registration.commandTitle,
                    description: registration.commandDescription,
                }),
            );
            expect(defaultKeybindings).toContainEqual({
                key: registration.defaultKeybinding,
                command: registration.commandId,
            });
        }
    });
});
