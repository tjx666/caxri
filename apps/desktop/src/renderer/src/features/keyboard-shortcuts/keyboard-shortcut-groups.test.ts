import type { Keybinding } from '@caxri/protocol';
import { defaultKeybindings, sessionOpenPinnedCommandIds } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { KeyboardShortcutLabels } from './keyboard-shortcut-groups';
import {
    buildKeyboardShortcutGroups,
    EXTENSION_SHORTCUT_CATEGORY,
    filterKeyboardShortcutGroups,
    PINNED_RANGE_COMMAND,
    sidebarShortcutGroup,
} from './keyboard-shortcut-groups';

const englishLabels: KeyboardShortcutLabels = {
    category: (category) => category,
    pinnedRangeTitle: 'Switch to pinned session',
    title: (command) => command.title,
};

const summary = (groups: ReturnType<typeof buildKeyboardShortcutGroups>) =>
    groups.map((group) => [
        group.category,
        group.entries.map((entry) => [entry.command, entry.keys]),
    ]);

describe('pinned session range', () => {
    const pinned = (): Keybinding[] =>
        sessionOpenPinnedCommandIds.map((command, index) => ({
            key: `cmd+${index + 1}`,
            command,
        }));

    it('folds the nine Switch to Pinned Session rows into one range row', () => {
        const groups = buildKeyboardShortcutGroups(pinned(), [], englishLabels);
        const entries = groups.flatMap((group) => group.entries);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
            command: PINNED_RANGE_COMMAND,
            isRange: true,
            keys: ['cmd+1', 'cmd+9'],
            titleLabel: 'Switch to pinned session',
        });
    });

    it('keeps the rows apart when a binding is missing or doubled', () => {
        const missing = pinned().slice(1);
        expect(
            buildKeyboardShortcutGroups(missing, [], englishLabels).flatMap((g) => g.entries),
        ).toHaveLength(8);
        const doubled = [...pinned(), { key: 'ctrl+1', command: sessionOpenPinnedCommandIds[0] }];
        expect(
            buildKeyboardShortcutGroups(doubled, [], englishLabels).flatMap((g) => g.entries),
        ).toHaveLength(9);
    });

    it('offers the sidebar list keys as their own group', () => {
        const group = sidebarShortcutGroup({
            archive: 'Archive',
            category: 'Session list',
            collapse: 'Collapse',
            expand: 'Expand',
            move: 'Move',
        });
        expect(group.entries.map((entry) => entry.keys)).toContainEqual(['delete']);
    });
});

describe('buildKeyboardShortcutGroups', () => {
    it('groups bound commands by category in catalog order, regardless of file order', () => {
        const keybindings: Keybinding[] = [
            { key: 'cmd+shift+s', command: 'session.search' },
            { key: 'cmd+t', command: 'terminal.new' },
            { key: 'cmd+n', command: 'session.create' },
            { key: 'cmd+o', command: 'project.create' },
        ];

        expect(summary(buildKeyboardShortcutGroups(keybindings, [], englishLabels))).toEqual([
            ['Project', [['project.create', ['cmd+o']]]],
            [
                'Session',
                [
                    ['session.create', ['cmd+n']],
                    ['session.search', ['cmd+shift+s']],
                ],
            ],
            ['Terminal', [['terminal.new', ['cmd+t']]]],
        ]);
    });

    it('shows every binding of a command once, including a user override beside the default', () => {
        const groups = buildKeyboardShortcutGroups(
            [
                { key: 'cmd+n', command: 'session.create' },
                { key: 'ctrl+n', command: 'session.create' },
                { key: 'cmd+n', command: 'session.create' },
            ],
            [],
            englishLabels,
        );

        expect(groups[0]?.entries[0]?.keys).toEqual(['cmd+n', 'ctrl+n']);
    });

    it('skips argument-carrying sendSequence bindings and commands nobody titles', () => {
        const groups = buildKeyboardShortcutGroups(
            [
                {
                    key: 'cmd+shift+enter',
                    command: 'workbench.action.terminal.sendSequence',
                    when: 'terminalFocus',
                    args: { text: '\t\n' },
                },
                { key: 'cmd+alt+9', command: 'someone.unknownCommand' },
                { key: 'cmd+alt+8', command: 'example.extension.run' },
            ],
            [{ id: 'example.extension.run', title: 'Run Example' }],
            englishLabels,
        );

        expect(summary(groups)).toEqual([
            [EXTENSION_SHORTCUT_CATEGORY, [['example.extension.run', ['cmd+alt+8']]]],
        ]);
    });

    it('lists the cheatsheet and New Session among the shipped defaults', () => {
        const commands = buildKeyboardShortcutGroups(defaultKeybindings, [], englishLabels)
            .flatMap((group) => group.entries)
            .map((entry) => entry.command);

        expect(commands).toEqual(
            expect.arrayContaining(['help.showKeyboardShortcuts', 'session.create']),
        );
        expect(commands).not.toContain('workbench.action.terminal.sendSequence');
    });

    it('carries the caller-resolved display labels', () => {
        const groups = buildKeyboardShortcutGroups(
            [{ key: 'cmd+n', command: 'session.create' }],
            [],
            {
                category: (category) => `[${category}]`,
                pinnedRangeTitle: 'Pinned',
                title: (command) => `<${command.title}>`,
            },
        );

        expect(groups).toMatchObject([
            { label: '[Session]', entries: [{ titleLabel: '<New Session>' }] },
        ]);
    });
});

describe('filterKeyboardShortcutGroups', () => {
    const groups = buildKeyboardShortcutGroups(
        [
            { key: 'cmd+n', command: 'session.create' },
            { key: 'cmd+shift+s', command: 'session.search' },
            { key: 'cmd+k cmd+s', command: 'settings.openKeybindings' },
        ],
        [],
        {
            category: (category) => (category === 'Session' ? '会话' : category),
            pinnedRangeTitle: 'Pinned',
            title: (command) => command.title,
        },
    );
    const commandsMatching = (query: string) =>
        filterKeyboardShortcutGroups(groups, query).flatMap((group) =>
            group.entries.map((entry) => entry.command),
        );

    it('returns every group for a blank query', () => {
        expect(filterKeyboardShortcutGroups(groups, ' '.repeat(3))).toEqual(groups);
    });

    it('matches titles case-insensitively and drops groups left empty', () => {
        expect(filterKeyboardShortcutGroups(groups, 'new SESSION')).toEqual([
            expect.objectContaining({
                category: 'Session',
                entries: [expect.objectContaining({ command: 'session.create' })],
            }),
        ]);
    });

    it('matches a category by its displayed or English name', () => {
        expect(commandsMatching('会话')).toEqual(['session.create', 'session.search']);
        expect(commandsMatching('session')).toEqual(['session.create', 'session.search']);
    });

    it('matches a shortcut as stored and as displayed', () => {
        expect(commandsMatching('cmd+k')).toEqual(['settings.openKeybindings']);
        expect(commandsMatching('⌘K ⌘S')).toEqual(['settings.openKeybindings']);
    });
});
