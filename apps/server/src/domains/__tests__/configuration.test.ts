// eslint-disable-next-line unicorn/name-replacements -- referenced by name in vitest.config.ts and scripts/__tests__/vitest-config-contract.test.ts; renaming is outside this change's scope.
import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerEvent } from '@caxri/protocol';
import {
    DEFAULT_FILES_EXCLUDE,
    findKeybindingConflicts,
    MAX_CONFIGURATION_SOURCE_BYTES,
    MAX_TERMINAL_INPUT_LENGTH,
} from '@caxri/protocol';
import parcelWatcher from '@parcel/watcher';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    createWatchDiagnosticHub,
    createWatchFailureProbe,
} from '../../__tests__/support/watch-diagnostics';
import { ConfigService } from '../config';
import { draculaTheme } from '../theme';

const temporaryDirectories: string[] = [];
afterEach(async () => {
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

describe('ConfigurationService', () => {
    it('fills provider executables and Terminal cwd defaults without rewriting an older settings file', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-agent-defaults-'));
        temporaryDirectories.push(directory);
        const configDirectory = join(directory, 'config');
        await mkdir(configDirectory);
        const original = '{"terminal.fontSize":15}';
        await writeFile(join(configDirectory, 'settings.jsonc'), original, 'utf8');
        const service = new ConfigService(directory, () => {});

        await service.initialize();

        expect(service.getSettings().value).toMatchObject({
            'agents.providers': {
                claude: {
                    hooks: { enabled: true },
                    launch: { executable: 'claude' },
                },
                codex: {
                    hooks: { enabled: true },
                    launch: { executable: 'codex' },
                },
            },
            'security.trustedDomains': [],
            'workbench.newWorktreeBehavior': 'ask',
            'terminal.defaultWorkingDirectory': null,
            'terminal.fontSize': 15,
            'terminal.gpuAcceleration': 'on',
        });
        expect(await readFile(service.settingsPath, 'utf8')).toBe(original);
        await service.close();
    });

    it('accepts independent provider argv and retains the previous settings after invalid input', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-agent-launch-'));
        temporaryDirectories.push(directory);
        const service = new ConfigService(directory, () => {});
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
        const service = new ConfigService(directory, () => {});
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
        const service = new ConfigService(directory, () => {});
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

    it('detects shortcut conflicts without flagging duplicate identical commands', () => {
        expect(
            findKeybindingConflicts([
                { key: 'cmd+t', command: 'terminal.new' },
                { key: 'CMD+T', command: 'terminal.new' },
                { key: 'cmd+t', command: 'session.create' },
            ]),
        ).toEqual([
            { key: 'cmd+t', commands: ['terminal.new', 'session.create'], reason: 'duplicate' },
        ]);
    });

    it('preserves contextual Terminal sequence arguments and rejects an invalid sequence binding', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-terminal-sequence-'));
        temporaryDirectories.push(directory);
        const service = new ConfigService(directory, () => {});
        await service.initialize();
        const source = String.raw`[
  {
    "key": "cmd+enter",
    "command": "workbench.action.terminal.sendSequence",
    "when": "terminalFocus",
    "args": { "text": "\u001b[1;3B" },
  },
]
`;

        await service.updateKeybindings(source);

        expect(service.getKeybindings()).toMatchObject({
            source,
            value: [
                {
                    args: { text: '\u{1B}[1;3B' },
                    command: 'workbench.action.terminal.sendSequence',
                    key: 'cmd+enter',
                    when: 'terminalFocus',
                },
            ],
        });
        const before = service.getKeybindings();
        await expect(
            service.updateKeybindings(
                JSON.stringify([
                    {
                        args: {},
                        command: 'workbench.action.terminal.sendSequence',
                        key: 'cmd+enter',
                    },
                ]),
            ),
        ).rejects.toThrow('requires args.text');
        expect(service.getKeybindings()).toEqual(before);
        const oversizedText = 'x'.repeat(MAX_TERMINAL_INPUT_LENGTH + 1);
        await expect(
            service.updateKeybindings(
                JSON.stringify([
                    {
                        args: { text: oversizedText },
                        command: 'workbench.action.terminal.sendSequence',
                        key: 'cmd+enter',
                    },
                ]),
            ),
        ).rejects.toThrow(`at most ${MAX_TERMINAL_INPUT_LENGTH} characters`);
        expect(service.getKeybindings()).toEqual(before);
        await service.close();
    });

    it('retains last-known-good settings after a parse failure', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-'));
        temporaryDirectories.push(directory);
        const service = new ConfigService(directory, () => {});
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
        const events: ServerEvent[] = [];
        const service = new ConfigService(directory, (event) => {
            events.push(event);
        });

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
        const events: ServerEvent[] = [];
        const service = new ConfigService(directory, (event) => {
            events.push(event);
        });

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
        const service = new ConfigService(directory, () => {});
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
        const service = new ConfigService(directory, () => {});
        await service.initialize();
        const before = service.getSettings();
        const source = `${JSON.stringify({ ...before.value, 'terminal.fontSize': 17 }, null, 2)}\n`;

        await rm(service.settingsPath);
        await mkdir(service.settingsPath);
        await expect(service.updateSettings(source)).rejects.toThrow();
        expect(service.getSettings()).toEqual(before);
        await service.close();
    });

    it('does not commit an external read that settles after close', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-close-read-'));
        temporaryDirectories.push(directory);
        const events: ServerEvent[] = [];
        const lateRead = Promise.withResolvers<string>();
        const readStarted = Promise.withResolvers<void>();
        let shouldDelaySettingsRead = false;
        const service = new ConfigService(directory, (event) => events.push(event), undefined, {
            readConfigSource: async (path) => {
                if (shouldDelaySettingsRead && path.endsWith('settings.jsonc')) {
                    readStarted.resolve();
                    return lateRead.promise;
                }
                return readFile(path, 'utf8');
            },
        });
        await service.initialize();
        const before = service.getSettings();
        events.length = 0;
        shouldDelaySettingsRead = true;
        const externalChange = (
            service as unknown as { onExternalChange(path: string): Promise<void> }
        ).onExternalChange(service.settingsPath);
        await readStarted.promise;

        await service.close();
        lateRead.resolve(
            `${JSON.stringify({ ...before.value, 'terminal.fontSize': 18 }, null, 2)}\n`,
        );
        await externalChange;

        expect(service.getSettings()).toEqual(before);
        expect(service.getErrors()).toEqual([]);
        expect(events).toEqual([]);
    });

    it('does not commit an external read error that settles after close', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-close-read-error-'));
        temporaryDirectories.push(directory);
        const events: ServerEvent[] = [];
        const lateRead = Promise.withResolvers<string>();
        const readStarted = Promise.withResolvers<void>();
        let shouldDelaySettingsRead = false;
        const service = new ConfigService(directory, (event) => events.push(event), undefined, {
            readConfigSource: async (path) => {
                if (shouldDelaySettingsRead && path.endsWith('settings.jsonc')) {
                    readStarted.resolve();
                    return lateRead.promise;
                }
                return readFile(path, 'utf8');
            },
        });
        await service.initialize();
        const before = service.getSettings();
        events.length = 0;
        shouldDelaySettingsRead = true;
        const externalChange = (
            service as unknown as { onExternalChange(path: string): Promise<void> }
        ).onExternalChange(service.settingsPath);
        await readStarted.promise;

        await service.close();
        lateRead.reject(new Error('late read failure'));
        await externalChange;

        expect(service.getSettings()).toEqual(before);
        expect(service.getErrors()).toEqual([]);
        expect(events).toEqual([]);
    });

    it('fences an in-flight write and the Settings mutations queued behind it on close', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-close-write-'));
        temporaryDirectories.push(directory);
        const events: ServerEvent[] = [];
        const writeRelease = Promise.withResolvers<void>();
        const writeStarted = Promise.withResolvers<void>();
        let shouldDelayWrites = false;
        let delayedWriteCount = 0;
        const service = new ConfigService(directory, (event) => events.push(event), undefined, {
            writeConfigSource: async (path, source) => {
                if (shouldDelayWrites) {
                    delayedWriteCount += 1;
                    writeStarted.resolve();
                    await writeRelease.promise;
                }
                await writeFile(path, source, 'utf8');
            },
        });
        await service.initialize();
        const before = service.getSettings();
        const firstSource = `${JSON.stringify({ ...before.value, 'terminal.fontSize': 17 }, null, 2)}\n`;
        const secondSource = `${JSON.stringify({ ...before.value, 'terminal.fontSize': 18 }, null, 2)}\n`;
        events.length = 0;
        shouldDelayWrites = true;
        const firstMutation = service.updateSettings(firstSource);
        await writeStarted.promise;
        const queuedMutation = service.updateSettings(secondSource);

        await service.close();
        writeRelease.resolve();
        const results = await Promise.allSettled([firstMutation, queuedMutation]);

        expect(results).toMatchObject([
            { status: 'rejected', reason: { code: 'UNAVAILABLE' } },
            { status: 'rejected', reason: { code: 'UNAVAILABLE' } },
        ]);
        expect(delayedWriteCount).toBe(1);
        expect(service.getSettings()).toEqual(before);
        expect(service.getErrors()).toEqual([]);
        expect(events).toEqual([]);
        await expect(service.updateTheme(service.getTheme().source)).rejects.toMatchObject({
            code: 'UNAVAILABLE',
        });
    });

    it('keeps theme state, source, file, and events unchanged after a low-contrast import', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-theme-contrast-'));
        temporaryDirectories.push(directory);
        const events: ServerEvent[] = [];
        const service = new ConfigService(directory, (event) => events.push(event));
        await service.initialize();
        events.length = 0;
        const before = service.getTheme();
        const beforeFile = await readFile(service.themePath, 'utf8');
        const imported = structuredClone(draculaTheme);
        imported.colors.muted = imported.colors.surface;
        const path = join(directory, 'low-contrast.json');
        await writeFile(path, JSON.stringify(imported), 'utf8');

        await expect(service.importTheme(path)).rejects.toMatchObject({ code: 'VALIDATION' });
        expect(service.getTheme()).toEqual(before);
        expect(await readFile(service.themePath, 'utf8')).toBe(beforeFile);
        expect(events).toEqual([]);
        await service.close();
    });

    it('reloads settings after an external atomic replacement', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-'));
        temporaryDirectories.push(directory);
        const events: ServerEvent[] = [];
        const watchHub = createWatchDiagnosticHub();
        const service = new ConfigService(
            directory,
            (event) => {
                events.push(event);
            },
            undefined,
            { watchHub },
        );
        await service.initialize();

        try {
            const diagnose = createWatchFailureProbe(watchHub, 'config', () => events.length);
            const source = `${JSON.stringify({ ...service.getSettings().value, 'terminal.fontSize': 16 }, null, 2)}\n`;
            const temporaryPath = `${service.settingsPath}.external.tmp`;
            await writeFile(temporaryPath, source, 'utf8');
            await rename(temporaryPath, service.settingsPath);

            await diagnose(
                expect
                    .poll(() => service.getSettings().value['terminal.fontSize'], {
                        timeout: 5_000,
                    })
                    .toBe(16),
            );
            expect(events.filter((event) => event.event === 'settings.changed')).toEqual([
                { event: 'settings.changed', payload: { source } },
            ]);
        } finally {
            await service.close();
            await watchHub.close();
        }
    });

    it('keeps last-known-good sources after oversized external replacements', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-oversized-reload-'));
        temporaryDirectories.push(directory);
        const events: ServerEvent[] = [];
        const watchHub = createWatchDiagnosticHub();
        const service = new ConfigService(
            directory,
            (event) => {
                events.push(event);
            },
            undefined,
            { watchHub },
        );
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
                const diagnose = createWatchFailureProbe(
                    watchHub,
                    'config',
                    () => events.filter((event) => event.event === testCase.event).length,
                );
                const previousSource = testCase.getSource();
                const temporaryPath = `${testCase.path}.external.tmp`;
                // eslint-disable-next-line no-await-in-loop -- each case resets shared `events` state and mutates the same watched path; running cases concurrently would race.
                await writeFile(
                    temporaryPath,
                    ' '.repeat(MAX_CONFIGURATION_SOURCE_BYTES + 1),
                    'utf8',
                );
                // eslint-disable-next-line no-await-in-loop -- rename must complete before polling for this case's event; cases share watched state and cannot run concurrently.
                await rename(temporaryPath, testCase.path);

                // eslint-disable-next-line no-await-in-loop -- polling this case's outcome must finish before resetting shared `events` state for the next case.
                await diagnose(
                    expect
                        .poll(
                            () => {
                                const payload = events.find(
                                    (event) => event.event === testCase.event,
                                )?.payload as { error?: string; source: string } | undefined;
                                return payload?.error;
                            },
                            { timeout: 5_000 },
                        )
                        .toContain('configuration source limit'),
                );
                expect(testCase.getSource()).toBe(previousSource);
                const payload = events.find((event) => event.event === testCase.event)?.payload as
                    { error?: string; source: string } | undefined;
                expect(payload?.source).toBe(previousSource);
            }
        } finally {
            await service.close();
            await watchHub.close();
        }
    });

    it('reports an unchanged oversized source only once while fallback polling', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-oversized-poll-'));
        temporaryDirectories.push(directory);
        const events: ServerEvent[] = [];
        const subscribe = vi
            .spyOn(parcelWatcher, 'subscribe')
            .mockRejectedValueOnce(new Error('watcher unavailable'));
        const fallbackPollIntervalMs = 25;
        const service = new ConfigService(
            directory,
            (event) => {
                events.push(event);
            },
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
        const events: ServerEvent[] = [];
        const service = new ConfigService(directory, (event) => {
            events.push(event);
        });
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
