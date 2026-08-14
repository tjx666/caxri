import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import parcelWatcher from '@parcel/watcher';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultKeybindings } from '../../shared/commands';
import { MAX_CONFIGURATION_SOURCE_BYTES } from '../../shared/configuration-contract';
import { findKeybindingConflicts } from '../../shared/configuration';
import type { RuntimeEvent } from '../../shared/ipc';
import { DEFAULT_FILES_EXCLUDE } from '../../shared/types';
import { ConfigurationService, previousDefaultKeybindingSets } from '../configuration';

const temporaryDirectories: string[] = [];
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
                claude: {
                    hooks: { enabled: false },
                    launch: { executable: 'claude', args: [] },
                },
                codex: {
                    hooks: { enabled: false },
                    launch: { executable: 'codex', args: [] },
                },
            },
            'security.trustedDomains': [],
            'workbench.newWorktreeBehavior': 'ask',
            'terminal.defaultWorkingDirectory': null,
            'terminal.fontSize': 15,
            'terminal.gpuAcceleration': 'off',
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

    it('atomically adds a normalized trusted domain without discarding Settings comments', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-trusted-domains-'));
        temporaryDirectories.push(directory);
        const service = new ConfigurationService(directory, () => undefined);
        await service.initialize();
        const source = `{
  // Keep this explanation when Main trusts an origin.
  "terminal.fontSize": 15,
}
`;
        await service.updateSettings(source);

        await service.trustDomain('HTTPS://Example.COM.:443');
        await service.trustDomain('https://example.com');

        expect(service.getSettings().value['security.trustedDomains']).toEqual([
            'https://example.com',
        ]);
        expect(await readFile(service.settingsPath, 'utf8')).toContain(
            '// Keep this explanation when Main trusts an origin.',
        );
        expect(await readFile(service.settingsPath, 'utf8')).toContain(
            '"security.trustedDomains": [',
        );

        const before = service.getSettings();
        await expect(service.trustDomain('*')).rejects.toThrow('Invalid trusted domain');
        expect(service.getSettings()).toEqual(before);
        await expect(
            service.updateSettings(
                JSON.stringify({
                    ...before.value,
                    'security.trustedDomains': ['*'],
                }),
            ),
        ).rejects.toThrow('security.trustedDomains');
        expect(service.getSettings()).toEqual(before);
        await service.close();
    });

    it('serializes concurrent trusted-domain writes so neither rule is lost', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-trusted-concurrency-'));
        temporaryDirectories.push(directory);
        const service = new ConfigurationService(directory, () => undefined);
        await service.initialize();

        await Promise.all([
            service.trustDomain('https://one.example.com'),
            service.trustDomain('https://two.example.com'),
        ]);

        expect(service.getSettings().value['security.trustedDomains']).toEqual([
            'https://one.example.com',
            'https://two.example.com',
        ]);
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

    it('detects shortcut conflicts without flagging duplicate identical commands', () => {
        expect(
            findKeybindingConflicts([
                { key: 'cmd+t', command: 'terminal.new' },
                { key: 'CMD+T', command: 'terminal.new' },
                { key: 'cmd+t', command: 'session.create' },
            ]),
        ).toEqual([{ key: 'cmd+t', commands: ['terminal.new', 'session.create'] }]);
    });

    /**
     * Drives the migration from the production derivation chain instead of rebuilding a past
     * release by filtering the current catalog. The old per-release fixtures did the latter, so
     * every added or rebound default silently made them describe a release that never existed.
     */
    it.each(previousDefaultKeybindingSets.map((set, index) => [index, set] as const))(
        'upgrades untouched historical default set %i to the current defaults',
        async (index, historical) => {
            const directory = await mkdtemp(join(tmpdir(), `caxri-config-legacy-${index}-`));
            temporaryDirectories.push(directory);
            const configDirectory = join(directory, 'config');
            await mkdir(configDirectory);
            await writeFile(
                join(configDirectory, 'keybindings.jsonc'),
                `${JSON.stringify(historical, null, 2)}\n`,
                'utf8',
            );
            const service = new ConfigurationService(directory, () => undefined);

            await service.initialize();

            expect(service.getKeybindings().value).toEqual(defaultKeybindings);
            /** The upgrade is written back, not just held in memory. */
            expect(
                JSON.parse(await readFile(join(configDirectory, 'keybindings.jsonc'), 'utf8')),
            ).toEqual(defaultKeybindings);
            await service.close();
        },
    );

    it('leaves a customized keybinding file untouched', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-custom-keybindings-'));
        temporaryDirectories.push(directory);
        const configDirectory = join(directory, 'config');
        await mkdir(configDirectory);
        const customized = [
            ...previousDefaultKeybindingSets[0],
            { key: 'cmd+shift+k', command: 'terminal.clear' },
        ];
        await writeFile(
            join(configDirectory, 'keybindings.jsonc'),
            `${JSON.stringify(customized, null, 2)}\n`,
            'utf8',
        );
        const service = new ConfigurationService(directory, () => undefined);

        await service.initialize();

        expect(service.getKeybindings().value).toEqual(customized);
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

    it('keeps bounded defaults when disk configuration sources are oversized at startup', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-oversized-startup-'));
        temporaryDirectories.push(directory);
        const configDirectory = join(directory, 'config');
        await mkdir(configDirectory);
        const oversizedSource = ' '.repeat(MAX_CONFIGURATION_SOURCE_BYTES + 1);
        await Promise.all(
            ['settings.jsonc', 'keybindings.jsonc', 'theme.json'].map((name) =>
                writeFile(join(configDirectory, name), oversizedSource, 'utf8'),
            ),
        );
        const events: RuntimeEvent[] = [];
        const service = new ConfigurationService(directory, (event) => events.push(event));

        await expect(service.initialize()).resolves.toBeUndefined();

        expect(service.getSettings().source.length).toBeLessThan(MAX_CONFIGURATION_SOURCE_BYTES);
        expect(service.getKeybindings().source.length).toBeLessThan(MAX_CONFIGURATION_SOURCE_BYTES);
        expect(service.getTheme().source.length).toBeLessThan(MAX_CONFIGURATION_SOURCE_BYTES);
        expect(service.getErrors()).toHaveLength(3);
        for (const eventName of [
            'settings.changed',
            'keybindings.changed',
            'theme.changed',
        ] as const) {
            const payload = events.find((event) => event.event === eventName)?.payload as
                { error?: string; source: string } | undefined;
            expect(payload?.error).toContain('configuration source limit');
            expect(Buffer.byteLength(payload?.source ?? '', 'utf8')).toBeLessThanOrEqual(
                MAX_CONFIGURATION_SOURCE_BYTES,
            );
        }
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

    it('keeps last-known-good sources after oversized external replacements', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-oversized-reload-'));
        temporaryDirectories.push(directory);
        const events: RuntimeEvent[] = [];
        const service = new ConfigurationService(directory, (event) => events.push(event));
        await service.initialize();
        const cases = [
            {
                event: 'settings.changed' as const,
                getSource: () => service.getSettings().source,
                path: service.settingsPath,
            },
            {
                event: 'keybindings.changed' as const,
                getSource: () => service.getKeybindings().source,
                path: service.keybindingsPath,
            },
            {
                event: 'theme.changed' as const,
                getSource: () => service.getTheme().source,
                path: service.themePath,
            },
        ];

        try {
            for (const testCase of cases) {
                events.length = 0;
                const previousSource = testCase.getSource();
                const temporaryPath = `${testCase.path}.external.tmp`;
                await writeFile(
                    temporaryPath,
                    ' '.repeat(MAX_CONFIGURATION_SOURCE_BYTES + 1),
                    'utf8',
                );
                await rename(temporaryPath, testCase.path);

                await expect
                    .poll(
                        () => {
                            const payload = events.find((event) => event.event === testCase.event)
                                ?.payload as { error?: string; source: string } | undefined;
                            return payload?.error;
                        },
                        { timeout: 5_000 },
                    )
                    .toContain('configuration source limit');
                expect(testCase.getSource()).toBe(previousSource);
                const payload = events.find((event) => event.event === testCase.event)?.payload as
                    { error?: string; source: string } | undefined;
                expect(payload?.source).toBe(previousSource);
            }
        } finally {
            await service.close();
        }
    });

    it('reports an unchanged oversized source only once while fallback polling', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-oversized-poll-'));
        temporaryDirectories.push(directory);
        const events: RuntimeEvent[] = [];
        const subscribe = vi
            .spyOn(parcelWatcher, 'subscribe')
            .mockRejectedValueOnce(new Error('watcher unavailable'));
        const fallbackPollIntervalMs = 25;
        const service = new ConfigurationService(
            directory,
            (event) => events.push(event),
            undefined,
            {
                fallbackPollIntervalMs,
            },
        );

        try {
            await service.initialize();
            events.length = 0;
            const temporaryPath = `${service.settingsPath}.external.tmp`;
            await writeFile(temporaryPath, ' '.repeat(MAX_CONFIGURATION_SOURCE_BYTES + 1), 'utf8');
            await rename(temporaryPath, service.settingsPath);

            await expect
                .poll(
                    () =>
                        events.filter(
                            (event) =>
                                event.event === 'settings.changed' &&
                                event.payload.error !== undefined,
                        ).length,
                    { timeout: 5_000 },
                )
                .toBe(1);
            await new Promise((resolve) => setTimeout(resolve, fallbackPollIntervalMs * 3));
            expect(
                events.filter(
                    (event) =>
                        event.event === 'settings.changed' && event.payload.error !== undefined,
                ),
            ).toHaveLength(1);
        } finally {
            await service.close();
            subscribe.mockRestore();
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
