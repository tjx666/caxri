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

/**
 * The first version and binding digest of every tagged default generation, oldest first. A user who installed that
 * version holds exactly those bindings in `keybindings.jsonc`, so the migration tests above prove nothing once a tagged
 * generation is edited to match what the code does today. Add the newest generation's line (the failure prints it) when
 * a later one is appended after it; never edit or remove an existing line. A range only grows its end version, so the
 * line keeps its first version.
 */
const taggedGenerationDigests: ReadonlyArray<readonly [firstVersion: string, digest: string]> = [
    ['v0.0.17', '640daaab73856b11'],
    ['v0.0.18', '0ac8332681a66300'],
    ['v0.0.20', 'f08ada5c67340c9c'],
    ['v0.0.21', 'fb9851da41b80a99'],
    ['v0.0.30', 'b8fe56c353a4fe2e'],
    ['v0.0.40', 'ef06a607dc415b51'],
    ['v0.0.43', '760fd425a30bd158'],
    ['v0.0.52', '1573c3c27905251a'],
    ['v0.0.53', '31b9354fabf0cee4'],
    ['v0.0.64', '5146b52255e3e359'],
    ['v0.0.75', 'e3bb458cec546a0f'],
    ['v0.0.90', '79d82c44964f1db6'],
    ['v0.0.98', 'f8cb09bc2901c577'],
    ['v0.0.101', '73755ffebeedca42'],
    ['v0.0.114', '0e367e6b3319c9cf'],
    ['v0.0.120', 'a4a2b71140da82a2'],
    ['v0.0.124', 'f007ea253bbc5e6c'],
    ['v0.0.127', 'b2ec2e1b6636ee5f'],
    ['v0.0.134', 'b2ec2e1b6636ee5f'],
    ['v0.0.135', '0f487a471ef3653d'],
    ['v0.0.138', '34a749658b210ddd'],
    ['v0.0.142', '761520263b04b76c'],
];

/**
 * Splits a generation id (`v0.0.18` or `v0.0.18-v0.0.19`) into its first and last version, each as numeric parts.
 */
function generationVersions(
    id: string,
): [first: string, firstParts: number[], lastParts: number[]] {
    const match = /^(v\d+\.\d+\.\d+)(?:-(v\d+\.\d+\.\d+))?$/.exec(id);
    if (!match) throw new Error(`Generation id ${id} is not vX.Y.Z or vX.Y.Z-vX.Y.Z`);
    const parts = (version: string) => version.slice(1).split('.').map(Number);
    return [match[1], parts(match[1]), parts(match.at(2) ?? match[1])];
}

function compareVersions(left: number[], right: number[]): number {
    const index = left.findIndex((part, position) => part !== right[position]);
    return index === -1 ? 0 : left[index] - right[index];
}

/**
 * A short SHA-256 of the bindings through Web Crypto, which this browser-safe package's tests can use without Node.
 */
async function bindingsDigest(bindings: readonly Keybinding[]): Promise<string> {
    const bytes = new TextEncoder().encode(JSON.stringify(bindings));
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return [...digest.subarray(0, 8)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

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
                { key: 'ctrl+alt+tab', command: 'session.switchMru' },
                { key: 'cmd+alt+3', command: 'secondarySidebar.showStatus' },
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
        ).toEqual([{ key: 'ctrl+alt+tab', command: 'session.switchMru' }]);
        expect(
            defaultKeybindings.filter(
                (binding) => binding.command === 'secondarySidebar.showStatus',
            ),
        ).toEqual([{ key: 'cmd+alt+3', command: 'secondarySidebar.showStatus' }]);
        const changes: readonly DefaultKeybindingChange[] = defaultKeybindingChanges;
        for (const [index, change] of changes.entries()) {
            // A removal names no current default.
            if (change.type === 'remove') continue;
            const current = change.type === 'add' ? change.binding : change.current;
            /**
             * A change a later `replace` moves on (Cmd+3 Status to Cmd+Alt+3) or a later `remove` withdraws is history,
             * not a current default.
             */
            const isSuperseded = changes
                .slice(index + 1)
                .some(
                    (later) =>
                        later.type !== 'add' &&
                        later.previous.key === current.key &&
                        later.previous.command === current.command,
                );
            if (!isSuperseded) expect(defaultKeybindings).toContainEqual(current);
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
            [
                'help.showKeyboardShortcuts',
                'help.openDocumentation',
                'help.openReleaseNotes',
                'help.reportIssue',
                'help.revealLogs',
            ],
            ['processExplorer.open', 'developer.togglePerformanceMonitor'],
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

    it('numbers released generations with unique, strictly increasing versions', () => {
        let previousLast: number[] | undefined;
        for (const { id } of releasedDefaultKeybindingGenerations) {
            const [, first, last] = generationVersions(id);
            expect(compareVersions(first, last), `${id} ends before it starts`).toBeLessThanOrEqual(
                0,
            );
            if (previousLast)
                expect(
                    compareVersions(first, previousLast),
                    `${id} does not start after the generation before it`,
                ).toBeGreaterThan(0);
            previousLast = last;
        }
    });

    /**
     * Only the newest generation may still be untagged (the fixture documents it as the current default set), so every
     * generation before it must match its recorded digest: a tagged generation only ever gains a successor.
     */
    it('only appends to the tagged generations of the default keybinding history', async () => {
        const generations = releasedDefaultKeybindingGenerations;
        expect(
            taggedGenerationDigests.length,
            'a tagged generation was removed from the history',
        ).toBeLessThanOrEqual(generations.length);
        for (const [index, generation] of generations.entries()) {
            const [firstVersion] = generationVersions(generation.id);
            // eslint-disable-next-line no-await-in-loop -- one digest per generation, compared in order.
            const digest = await bindingsDigest(generation.bindings);
            const recorded = taggedGenerationDigests.at(index);
            if (!recorded) {
                expect(
                    index,
                    `${generation.id} is no longer the newest generation; add ['${firstVersion}', '${digest}'] to taggedGenerationDigests`,
                ).toBe(generations.length - 1);
                continue;
            }
            expect(
                [firstVersion, digest],
                `${generation.id} is tagged; append a new generation instead of rewriting it`,
            ).toEqual(recorded);
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
