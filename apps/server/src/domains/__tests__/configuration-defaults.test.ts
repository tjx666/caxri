// eslint-disable-next-line unicorn/name-replacements -- mirrors `configuration.test.ts`, which is referenced by name in vitest.config.ts; renaming is outside this change's scope.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultKeybindingChanges, defaultKeybindings } from '@caxri/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { ConfigService } from '../config';

const temporaryDirectories: string[] = [];
const migratedDefaultKeybindingAdditions = defaultKeybindingChanges.flatMap((change) =>
    change.type === 'add' ? [change.binding] : [],
);

afterEach(async () => {
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * A configuration file is materialized with every key at its default, so a later default change reaches nobody who
 * already has the file. These are the tests for the reviewed tables that carry such a change forward, and for the
 * larger half of the contract: a value the user chose stays theirs.
 */
describe('Configuration default reconciliation', () => {
    it('replaces the exact previous Open File Path default while preserving its JSONC comment', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-keybinding-migration-'));
        temporaryDirectories.push(directory);
        const configDirectory = join(directory, 'config');
        await mkdir(configDirectory);
        await writeFile(
            join(configDirectory, 'keybindings.jsonc'),
            `[
  // Keep the explanation attached to the migrated default.
  { "key": "alt+p", "command": "pathBrowser.open" },
  { "key": "cmd+t", "command": "terminal.new" },
]
`,
            'utf8',
        );
        const service = new ConfigService(directory, () => {});

        await service.initialize();

        expect(service.getKeybindings().value).toEqual([
            { key: 'cmd+p', command: 'pathBrowser.open' },
            { key: 'cmd+t', command: 'terminal.new' },
            ...migratedDefaultKeybindingAdditions,
        ]);
        const source = await readFile(service.keybindingsPath, 'utf8');
        expect(source).toContain('// Keep the explanation attached to the migrated default.');
        expect(source).toContain('"key": "cmd+p"');
        expect(source).not.toContain('"key": "alt+p"');
        await service.close();
    });

    /**
     * `settings.jsonc` is written with every key materialized at its default, so improving a default reaches nobody who
     * already has the file. The Terminal word separators are the case that exposed it: an install predating Chinese
     * punctuation kept selecting a whole sentence on double-click.
     */
    it('carries a superseded settings default forward while leaving a customized key alone', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-settings-migration-'));
        temporaryDirectories.push(directory);
        const configDirectory = join(directory, 'config');
        await mkdir(configDirectory);
        await writeFile(
            join(configDirectory, 'settings.jsonc'),
            `{
  // Keep the explanation attached to the migrated default.
  "terminal.wordSeparators": " ()[]{}',\\"\`─‘’“”|",
  "workbench.externalEditor": "code"
}
`,
            'utf8',
        );
        const service = new ConfigService(directory, () => {});

        await service.initialize();

        expect(service.getSettings().value['terminal.wordSeparators']).toContain('，');
        expect(service.getSettings().value['workbench.externalEditor']).toBe('code');
        const source = await readFile(service.settingsPath, 'utf8');
        expect(source).toContain('// Keep the explanation attached to the migrated default.');
        expect(source).toContain('，');
        await service.close();
    });

    it('leaves a customized word separator list untouched', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-settings-custom-'));
        temporaryDirectories.push(directory);
        const configDirectory = join(directory, 'config');
        await mkdir(configDirectory);
        await writeFile(
            join(configDirectory, 'settings.jsonc'),
            `{ "terminal.wordSeparators": " |" }\n`,
            'utf8',
        );
        const service = new ConfigService(directory, () => {});

        await service.initialize();

        expect(service.getSettings().value['terminal.wordSeparators']).toBe(' |');
        await service.close();
    });

    it('preserves a customized Open File Path binding while adding an unrelated default', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-keybinding-custom-'));
        temporaryDirectories.push(directory);
        const configDirectory = join(directory, 'config');
        await mkdir(configDirectory);
        const customized = [{ key: 'cmd+alt+o', command: 'pathBrowser.open' }];
        const source = `${JSON.stringify(customized, null, 2)}\n`;
        await writeFile(join(configDirectory, 'keybindings.jsonc'), source, 'utf8');
        const service = new ConfigService(directory, () => {});

        await service.initialize();

        expect(service.getKeybindings().value).toEqual([
            ...customized,
            ...migratedDefaultKeybindingAdditions,
        ]);
        expect(await readFile(service.keybindingsPath, 'utf8')).toContain('"key": "cmd+alt+o"');
        await service.close();
    });

    it('preserves the previous Open File Path default when Cmd+P is already occupied', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-keybinding-conflict-'));
        temporaryDirectories.push(directory);
        const configDirectory = join(directory, 'config');
        await mkdir(configDirectory);
        const conflicted = [
            { key: 'alt+p', command: 'pathBrowser.open' },
            { key: 'cmd+p', command: 'terminal.new' },
        ];
        const source = `${JSON.stringify(conflicted, null, 2)}\n`;
        await writeFile(join(configDirectory, 'keybindings.jsonc'), source, 'utf8');
        const service = new ConfigService(directory, () => {});

        await service.initialize();

        expect(service.getKeybindings().value).toEqual([
            ...conflicted,
            ...migratedDefaultKeybindingAdditions,
        ]);
        expect(await readFile(service.keybindingsPath, 'utf8')).toContain('"key": "alt+p"');
        await service.close();
    });

    it('uses the valid original keybindings when persisting a default migration fails', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-keybinding-readonly-'));
        temporaryDirectories.push(directory);
        const configDirectory = join(directory, 'config');
        await mkdir(configDirectory);
        const original = [
            { key: 'alt+p', command: 'pathBrowser.open' },
            { key: 'cmd+alt+t', command: 'terminal.new' },
        ];
        const source = `${JSON.stringify(original, null, 2)}\n`;
        const keybindingsPath = join(configDirectory, 'keybindings.jsonc');
        await writeFile(keybindingsPath, source, 'utf8');
        const service = new ConfigService(directory, () => {}, undefined, {
            writeConfigSource: async (path, nextSource) => {
                if (path === keybindingsPath) throw new Error('read-only keybindings fixture');
                await writeFile(path, nextSource, 'utf8');
            },
        });

        await service.initialize();

        expect(service.getKeybindings()).toMatchObject({ value: original, source });
        expect(service.getErrors()).toEqual(['keybindings.jsonc: read-only keybindings fixture']);
        expect(await readFile(keybindingsPath, 'utf8')).toBe(source);
        await service.close();
    });

    it('replaces the exact previous Session MRU default with Cmd+Backquote', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-session-mru-migration-'));
        temporaryDirectories.push(directory);
        const configDirectory = join(directory, 'config');
        await mkdir(configDirectory);
        const previous = [{ key: 'ctrl+alt+tab', command: 'session.switchMru' }];
        await writeFile(
            join(configDirectory, 'keybindings.jsonc'),
            `${JSON.stringify(previous, null, 2)}\n`,
            'utf8',
        );
        const service = new ConfigService(directory, () => {});

        await service.initialize();

        expect(service.getKeybindings().value).toEqual([
            { key: 'cmd+`', command: 'session.switchMru' },
            ...migratedDefaultKeybindingAdditions,
        ]);
        expect(await readFile(service.keybindingsPath, 'utf8')).toContain('"key": "cmd+`"');
        await service.close();
    });

    it('adds the Status shortcut to an existing keybinding file when Cmd+3 is free', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-status-shortcut-addition-'));
        temporaryDirectories.push(directory);
        const configDirectory = join(directory, 'config');
        await mkdir(configDirectory);
        await writeFile(
            join(configDirectory, 'keybindings.jsonc'),
            `${JSON.stringify([{ key: 'cmd+1', command: 'secondarySidebar.showFiles' }], null, 2)}\n`,
            'utf8',
        );
        const service = new ConfigService(directory, () => {});

        await service.initialize();

        expect(service.getKeybindings().value).toEqual([
            { key: 'cmd+alt+1', command: 'secondarySidebar.showFiles' },
            ...migratedDefaultKeybindingAdditions,
        ]);
        const saved = await readFile(service.keybindingsPath, 'utf8');
        expect(saved).toContain('secondarySidebar.showStatus');
        await service.close();
    });

    it('leaves a customized keybinding file untouched', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-custom-keybindings-'));
        temporaryDirectories.push(directory);
        const configDirectory = join(directory, 'config');
        await mkdir(configDirectory);
        const customized = [
            ...defaultKeybindings,
            { key: 'cmd+shift+k', command: 'terminal.clear' },
        ];
        await writeFile(
            join(configDirectory, 'keybindings.jsonc'),
            `${JSON.stringify(customized, null, 2)}\n`,
            'utf8',
        );
        const service = new ConfigService(directory, () => {});

        await service.initialize();

        expect(service.getKeybindings().value).toEqual(customized);
        await service.close();
    });
});
