import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { defaultKeybindings } from '../../shared/commands';
import type { RuntimeEvent } from '../../shared/ipc';
import { DEFAULT_FILES_EXCLUDE } from '../../shared/types';
import { ConfigurationService, findKeybindingConflicts } from '../configuration';

const temporaryDirectories: string[] = [];
const v002DefaultKeybindings = defaultKeybindings
    .filter((binding) => binding.command !== 'pathBrowser.open')
    .map((binding) =>
        binding.command === 'workbench.closeActiveTab'
            ? { ...binding, command: 'terminal.close' }
            : binding,
    );

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
});

describe('ConfigurationService', () => {
    it('fills provider launch and Terminal cwd defaults without rewriting an older settings file', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-agent-defaults-'));
        temporaryDirectories.push(directory);
        const configDirectory = join(directory, 'config');
        await mkdir(configDirectory);
        const original = '{"terminal.fontSize":15}';
        await writeFile(join(configDirectory, 'settings.jsonc'), original, 'utf8');
        const service = new ConfigurationService(directory, () => undefined);

        await service.initialize();

        expect(service.getSettings().value).toMatchObject({
            'agents.providers': {
                claude: { launch: { executable: 'claude', args: [] } },
                codex: { launch: { executable: 'codex', args: [] } },
            },
            'terminal.defaultWorkingDirectory': null,
            'terminal.fontSize': 15,
        });
        expect(await readFile(service.settingsPath, 'utf8')).toBe(original);
        await service.close();
    });

    it('accepts independent provider argv and retains the previous settings after invalid input', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-agent-launch-'));
        temporaryDirectories.push(directory);
        const service = new ConfigurationService(directory, () => undefined);
        await service.initialize();
        const customized = {
            ...service.getSettings().value,
            'agents.providers': {
                claude: { launch: { executable: '/opt/bin/claude', args: ['--model', 'opus'] } },
                codex: { launch: { executable: 'codex-custom', args: ['--search'] } },
            },
            'terminal.defaultWorkingDirectory': '~/play',
        };

        await service.updateSettings(JSON.stringify(customized));
        expect(service.getSettings().value).toMatchObject(customized);
        const before = service.getSettings();
        await expect(
            service.updateSettings(
                JSON.stringify({
                    ...customized,
                    'agents.providers': {
                        ...customized['agents.providers'],
                        codex: { launch: { executable: '', args: [] } },
                    },
                }),
            ),
        ).rejects.toThrow();
        expect(service.getSettings()).toEqual(before);
        await service.close();
    });

    it('upgrades the original untouched defaults instead of preserving retired commands', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-original-defaults-'));
        temporaryDirectories.push(directory);
        const configDirectory = join(directory, 'config');
        await mkdir(configDirectory);
        await writeFile(
            join(configDirectory, 'keybindings.jsonc'),
            `${JSON.stringify(
                [
                    { key: 'cmd+shift+p', command: 'commandPalette.open' },
                    { key: 'cmd+n', command: 'session.create' },
                    { key: 'cmd+t', command: 'terminal.new' },
                    { key: 'cmd+shift+r', command: 'terminal.restart' },
                    { key: 'cmd+w', command: 'terminal.close' },
                    { key: 'cmd+s', command: 'editor.save' },
                    { key: 'cmd+1', command: 'inspector.showFiles' },
                    { key: 'cmd+2', command: 'inspector.showGit' },
                    { key: 'cmd+3', command: 'inspector.showAgent' },
                    { key: 'cmd+,', command: 'theme.openSettings' },
                ],
                null,
                2,
            )}\n`,
            'utf8',
        );
        const service = new ConfigurationService(directory, () => undefined);

        await service.initialize();

        expect(service.getKeybindings().value).toEqual(defaultKeybindings);
        expect(service.getKeybindings().value).toContainEqual({
            command: 'inspector.searchFiles',
            key: 'cmd+shift+f',
        });
        expect(
            JSON.parse(await readFile(join(configDirectory, 'keybindings.jsonc'), 'utf8')),
        ).toEqual(defaultKeybindings);
        await service.close();
    });

    it('adds newly shipped shortcuts to an untouched legacy default keybinding set', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-keybinding-defaults-'));
        temporaryDirectories.push(directory);
        const configDirectory = join(directory, 'config');
        await mkdir(configDirectory);
        await writeFile(
            join(configDirectory, 'keybindings.jsonc'),
            `${JSON.stringify(
                v002DefaultKeybindings.filter(
                    (binding) =>
                        !['inspector.searchFiles', 'inspector.toggle', 'sidebar.toggle'].includes(
                            binding.command,
                        ),
                ),
                null,
                2,
            )}\n`,
            'utf8',
        );
        const service = new ConfigurationService(directory, () => undefined);

        await service.initialize();

        expect(service.getKeybindings().value).toContainEqual({
            command: 'inspector.searchFiles',
            key: 'cmd+shift+f',
        });
        expect(service.getKeybindings().value).toContainEqual({
            command: 'sidebar.toggle',
            key: 'cmd+[',
        });
        expect(service.getKeybindings().value).toContainEqual({
            command: 'inspector.toggle',
            key: 'cmd+]',
        });
        expect(service.getKeybindings().source).toContain('inspector.searchFiles');
        expect(
            JSON.parse(await readFile(join(configDirectory, 'keybindings.jsonc'), 'utf8')),
        ).toEqual(defaultKeybindings);
        await service.close();
    });

    it('adds panel shortcuts to the immediately previous untouched defaults', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-panel-shortcuts-'));
        temporaryDirectories.push(directory);
        const configDirectory = join(directory, 'config');
        await mkdir(configDirectory);
        await writeFile(
            join(configDirectory, 'keybindings.jsonc'),
            `${JSON.stringify(
                v002DefaultKeybindings.filter(
                    (binding) => !['inspector.toggle', 'sidebar.toggle'].includes(binding.command),
                ),
                null,
                2,
            )}\n`,
            'utf8',
        );
        const service = new ConfigurationService(directory, () => undefined);

        await service.initialize();

        expect(service.getKeybindings().value).toEqual(defaultKeybindings);
        await service.close();
    });

    it('detects shortcut conflicts without flagging duplicate identical commands', () => {
        expect(
            findKeybindingConflicts([
                { key: 'cmd+t', command: 'terminal.new' },
                { key: 'CMD+T', command: 'terminal.new' },
                { key: 'cmd+t', command: 'session.create' },
            ]),
        ).toEqual([{ key: 'cmd+t', commands: ['terminal.new', 'session.create'] }]);
    });

    it('adds the path browser shortcut to the immediately previous untouched defaults', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-path-browser-shortcut-'));
        temporaryDirectories.push(directory);
        const configDirectory = join(directory, 'config');
        await mkdir(configDirectory);
        await writeFile(
            join(configDirectory, 'keybindings.jsonc'),
            `${JSON.stringify(
                defaultKeybindings.filter((binding) => binding.command !== 'pathBrowser.open'),
                null,
                2,
            )}\n`,
            'utf8',
        );
        const service = new ConfigurationService(directory, () => undefined);

        await service.initialize();

        expect(service.getKeybindings().value).toContainEqual({
            command: 'pathBrowser.open',
            key: 'cmd+p',
        });
        expect(
            JSON.parse(await readFile(join(configDirectory, 'keybindings.jsonc'), 'utf8')),
        ).toEqual(defaultKeybindings);
        await service.close();
    });

    it('retains last-known-good settings after a parse failure', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-'));
        temporaryDirectories.push(directory);
        const service = new ConfigurationService(directory, () => undefined);
        await service.initialize();
        const before = service.getSettings();
        await expect(service.updateSettings('{ broken')).rejects.toThrow(
            /settings\.jsonc:.*line 1, column/,
        );
        expect(service.getSettings()).toEqual(before);
        await service.close();
    });

    it('starts with last-known-good defaults when an existing settings file is invalid', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-startup-'));
        temporaryDirectories.push(directory);
        const configDirectory = join(directory, 'config');
        await mkdir(configDirectory);
        await writeFile(join(configDirectory, 'settings.jsonc'), '{ broken', 'utf8');
        const events: RuntimeEvent[] = [];
        const service = new ConfigurationService(directory, (event) => events.push(event));

        await expect(service.initialize()).resolves.toBeUndefined();
        expect(service.getSettings().value['terminal.fontSize']).toBe(13);
        expect(
            events.some(
                (event) =>
                    event.event === 'settings.changed' &&
                    event.payload.error?.includes('settings.jsonc'),
            ),
        ).toBe(true);
        await service.close();
    });

    it('merges file-tree exclusions with defaults without hiding dependency directories', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-files-exclude-'));
        temporaryDirectories.push(directory);
        const service = new ConfigurationService(directory, () => undefined);
        await service.initialize();

        expect(service.getSettings().value['files.exclude']).toEqual(DEFAULT_FILES_EXCLUDE);
        expect(service.getSettings().value['files.exclude']).not.toHaveProperty('**/node_modules');
        const source = `${JSON.stringify(
            {
                ...service.getSettings().value,
                'files.exclude': { '**/.git': false, '**/generated': true },
            },
            null,
            2,
        )}\n`;

        await service.updateSettings(source);
        expect(service.getSettings().value['files.exclude']).toMatchObject({
            '**/.git': false,
            '**/.hg': true,
            '**/generated': true,
        });
        await service.close();
    });

    it('does not change in-memory settings when the atomic disk write fails', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-write-'));
        temporaryDirectories.push(directory);
        const service = new ConfigurationService(directory, () => undefined);
        await service.initialize();
        const before = service.getSettings();
        const source = `${JSON.stringify({ ...before.value, 'terminal.fontSize': 17 }, null, 2)}\n`;

        await rm(service.settingsPath);
        await mkdir(service.settingsPath);
        await expect(service.updateSettings(source)).rejects.toThrow();
        expect(service.getSettings()).toEqual(before);
        await service.close();
    });

    it('reloads settings after an external atomic replacement', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-'));
        temporaryDirectories.push(directory);
        const events: RuntimeEvent[] = [];
        const service = new ConfigurationService(directory, (event) => events.push(event));
        await service.initialize();

        try {
            const source = `${JSON.stringify({ ...service.getSettings().value, 'terminal.fontSize': 16 }, null, 2)}\n`;
            const temporaryPath = `${service.settingsPath}.external.tmp`;
            await writeFile(temporaryPath, source, 'utf8');
            await rename(temporaryPath, service.settingsPath);

            await expect
                .poll(() => service.getSettings().value['terminal.fontSize'], { timeout: 5_000 })
                .toBe(16);
            expect(events.filter((event) => event.event === 'settings.changed')).toEqual([
                { event: 'settings.changed', payload: { source } },
            ]);
        } finally {
            await service.close();
        }
    });

    it('does not emit a second change when the watcher observes an internal write', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-'));
        temporaryDirectories.push(directory);
        const events: RuntimeEvent[] = [];
        const service = new ConfigurationService(directory, (event) => events.push(event));
        await service.initialize();

        try {
            const source = `${JSON.stringify({ ...service.getSettings().value, 'terminal.fontSize': 15 }, null, 2)}\n`;
            await service.updateSettings(source);
            await new Promise((resolve) => setTimeout(resolve, 500));

            expect(events.filter((event) => event.event === 'settings.changed')).toEqual([
                { event: 'settings.changed', payload: { source } },
            ]);
        } finally {
            await service.close();
        }
    });
});
