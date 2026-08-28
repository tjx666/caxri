import { commandIds } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { DefaultKeybindingChange } from '../../configuration/config-files';
import {
    commandDefinitions,
    defaultKeybindingChanges,
    defaultKeybindings,
    getNativeMenuCommandGroups,
    nativeMenuIds,
} from '../command-catalog';

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
                {
                    key: 'cmd+shift+o',
                    command: 'terminal.openDetectedLink',
                    when: 'terminalFocus',
                },
                { key: 'cmd+[', command: 'primarySidebar.toggle' },
                { key: 'cmd+]', command: 'secondarySidebar.toggle' },
                { key: 'cmd+shift+f', command: 'secondarySidebar.searchFiles' },
                { key: 'cmd+,', command: 'settings.open' },
                { key: 'cmd+p', command: 'pathBrowser.open' },
                { key: 'cmd+shift+p', command: 'commandPalette.open' },
                { key: 'cmd+shift+a', command: 'agentActions.open' },
                { key: 'cmd+`', command: 'session.switchMru' },
                { key: 'cmd+3', command: 'secondarySidebar.showStatus' },
                { key: 'cmd+t', command: 'terminal.new' },
                { key: 'cmd+w', command: 'workbench.closeActiveTab' },
            ]),
        );
        expect(
            defaultKeybindings.filter((binding) => binding.command === 'pathBrowser.open'),
        ).toEqual([{ key: 'cmd+p', command: 'pathBrowser.open' }]);
        expect(
            defaultKeybindings.filter((binding) => binding.command === 'session.switchMru'),
        ).toEqual([{ key: 'cmd+`', command: 'session.switchMru' }]);
        expect(
            defaultKeybindings.filter(
                (binding) => binding.command === 'secondarySidebar.showStatus',
            ),
        ).toEqual([{ key: 'cmd+3', command: 'secondarySidebar.showStatus' }]);
        const changes: readonly DefaultKeybindingChange[] = defaultKeybindingChanges;
        for (const change of changes) {
            const current = change.type === 'add' ? change.binding : change.current;
            expect(defaultKeybindings).toContainEqual(current);
        }
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
                'secondarySidebar.showStatus',
                'panel.showLogs',
                'panel.showInfo',
            ]),
        );
        expect(commandDefinitions.some(({ id }) => id.startsWith('viewContainers.show.'))).toBe(
            false,
        );
    });
});
