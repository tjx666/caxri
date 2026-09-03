import { commandIds } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { DefaultKeybindingChange } from '../../configuration/config-files';
import { reconcileDefaultKeybindings } from '../../configuration/config-files';
import {
    commandDefinitions,
    defaultKeybindingChanges,
    defaultKeybindings,
    getNativeMenuCommandGroups,
    nativeMenuIds,
} from '../command-catalog';
import type { Keybinding } from '../domain';
import { releasedDefaultKeybindingGenerations } from './default-keybinding-history.fixture';

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
                {
                    key: 'cmd+shift+enter',
                    command: 'workbench.action.terminal.sendSequence',
                    when: 'terminalFocus',
                    args: { text: '\t\n' },
                },
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

    it('gates Detach/Resume Agent on the current session having the matching Agent Terminal', () => {
        const detach = commandDefinitions.find((command) => command.id === 'session.detach');
        const resume = commandDefinitions.find((command) => command.id === 'session.resume');
        expect(detach?.when).toBe('sessionHasLiveAgent');
        expect(resume?.when).toBe('sessionHasDetachedAgent');
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
            ['session.create', 'session.delete', 'session.archive'],
            ['session.selectPrevious', 'session.selectNext'],
            ['session.navigateBack', 'session.navigateForward'],
            ['session.detach', 'session.resume'],
        ]);
    });

    it('migrates every released default generation to commands the current catalog can execute', () => {
        const currentCommandIds = new Set<string>(commandDefinitions.map(({ id }) => id));

        for (const generation of releasedDefaultKeybindingGenerations) {
            const migrated = reconcileDefaultKeybindings(
                generation.bindings,
                defaultKeybindingChanges,
            ).value;
            const unknownCommands = migrated
                .map(({ command }) => command)
                .filter((command) => !currentCommandIds.has(command));
            expect(unknownCommands, `unmigrated commands in ${generation.id}`).toEqual([]);
        }
        expect(releasedDefaultKeybindingGenerations.at(-1)?.bindings).toEqual(defaultKeybindings);
    });

    it('keeps every declared replacement executable in isolation', () => {
        const releasedDefaults: Keybinding[] = [];
        for (const { bindings } of releasedDefaultKeybindingGenerations)
            releasedDefaults.push(...bindings);
        for (const change of defaultKeybindingChanges) {
            if (change.type !== 'replace') continue;
            expect(
                releasedDefaults,
                `default migration has no released source for ${change.previous.command}`,
            ).toContainEqual(change.previous);
            expect(
                reconcileDefaultKeybindings([change.previous], [change]).value,
                `default migration does not replace ${change.previous.command}`,
            ).toEqual([change.current]);
        }
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
