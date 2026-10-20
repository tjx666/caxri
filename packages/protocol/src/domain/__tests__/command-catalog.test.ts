import { commandIds } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { DefaultKeybindingChange } from '../../configuration/config-files';
import {
    findKeybindingConflicts,
    reconcileDefaultKeybindings,
} from '../../configuration/config-files';
import { commandDefinitions, getNativeMenuCommandGroups, nativeMenuIds } from '../command-catalog';
import { defaultKeybindingChanges, defaultKeybindings } from '../default-keybindings';
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
                { key: 'cmd+shift+k', command: 'terminal.clear', when: 'terminalFocus' },
                { key: 'cmd+f', command: 'terminal.find' },
                { key: 'cmd+k cmd+s', command: 'settings.openKeybindings' },
                { key: 'cmd+k v', command: 'editor.openPreviewToSide' },
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
                { key: 'cmd+\\', command: 'terminal.newInSplit' },
                {
                    key: 'cmd+shift+enter',
                    command: 'workbench.action.terminal.sendSequence',
                    when: 'terminalFocus',
                    args: { text: '\t\n' },
                },
                { key: 'cmd+w', command: 'workbench.closeActiveTab' },
                { key: 'cmd+shift+b', command: 'developer.reportBug' },
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
                category: 'Help',
            }),
        );
    });

    it('gates Detach/Resume Agent on the current session having the matching Agent Terminal', () => {
        const detach = commandDefinitions.find((command) => command.id === 'session.detach');
        const resume = commandDefinitions.find((command) => command.id === 'session.resume');
        expect(detach?.when).toBe('sessionHasLiveAgent');
        expect(resume?.when).toBe('sessionHasDetachedAgent');
    });

    it('gates Open Pull Request on the current session carrying a pull request', () => {
        const open = commandDefinitions.find((command) => command.id === 'session.openPullRequest');
        expect(open?.when).toBe('sessionHasPullRequest');
        expect(open?.nativeMenu).toBeUndefined();
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
            ['session.create', 'session.rename', 'session.delete', 'session.archive'],
            ['session.selectPrevious', 'session.selectNext'],
            ['session.navigateBack', 'session.navigateForward'],
            ['session.detach', 'session.resume'],
            ['session.openArchived', 'session.search'],
        ]);
        expect(
            getNativeMenuCommandGroups('help').map((group) => group.map((command) => command.id)),
        ).toEqual([
            ['help.showKeyboardShortcuts'],
            ['processExplorer.open'],
            ['developer.reportBug', 'diagnostics.export'],
        ]);
        expect(getNativeMenuCommandGroups('terminal')[0]?.map((command) => command.id)).toEqual([
            'terminal.new',
            'terminal.clear',
            'terminal.restart',
            'terminal.startNewAgentSession',
            'terminal.switchAgentSurface',
            'terminal.close',
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

    /**
     * A default added without its `add` change reaches new installs only: every existing `keybindings.jsonc` keeps the
     * old set, and nothing else fails. Upgrading the newest tagged generation must therefore land on every current
     * default.
     */
    it('brings the newest released generation up to every current default', () => {
        const released = releasedDefaultKeybindingGenerations.at(-2);
        expect(released).toBeDefined();
        const migrated = reconcileDefaultKeybindings(
            released?.bindings ?? [],
            defaultKeybindingChanges,
        ).value;
        for (const binding of defaultKeybindings)
            expect(migrated, `${released?.id} did not receive ${binding.key}`).toContainEqual(
                binding,
            );
        expect(migrated).toContainEqual({ key: 'cmd+n', command: 'session.create' });
        expect(migrated).toContainEqual({
            key: 'cmd+k cmd+r',
            command: 'help.showKeyboardShortcuts',
        });
    });

    /**
     * `reconcileDefaultKeybindings` fails closed, so a change whose destination chord is still occupied is skipped in
     * silence. Array order is the only thing keeping the `cmd+k` → `cmd+shift+k` replacement ahead of the `cmd+k …`
     * additions, and an upgrade that quietly lost both sequences would otherwise fail nothing: skipped means absent,
     * and absent conflicts with nothing.
     */
    it('frees Cmd+K before the sequences that claim it, for every generation that held it', () => {
        const chordDefaults = defaultKeybindings.filter(({ key }) => key.startsWith('cmd+k '));
        expect(chordDefaults.length).toBeGreaterThan(0);

        for (const generation of releasedDefaultKeybindingGenerations) {
            if (generation.bindings.every(({ key }) => key !== 'cmd+k')) continue;
            const migrated = reconcileDefaultKeybindings(
                generation.bindings,
                defaultKeybindingChanges,
            ).value;
            expect(
                migrated,
                `${generation.id} kept Cmd+K bound to a single command`,
            ).not.toContainEqual(expect.objectContaining({ key: 'cmd+k' }));
            for (const binding of chordDefaults)
                expect(migrated, `${generation.id} did not receive ${binding.key}`).toContainEqual(
                    binding,
                );
        }
    });

    /**
     * A shipped default that can never fire is invisible until a user reports it: `Cmd+K` held Terminal Clear right up
     * until it also had to open `Cmd+K Cmd+S`, and nothing mechanical would have caught the overlap.
     */
    it('ships defaults no chord or sequence shadows', () => {
        expect(findKeybindingConflicts(defaultKeybindings)).toEqual([]);
        for (const generation of releasedDefaultKeybindingGenerations) {
            expect(
                findKeybindingConflicts(
                    reconcileDefaultKeybindings(generation.bindings, defaultKeybindingChanges)
                        .value,
                ),
                `migrated ${generation.id} keeps a shadowed keybinding`,
            ).toEqual([]);
        }
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
