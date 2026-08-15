import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultAgentProviderSettings } from '../../../../shared/agents';
import type { RuntimeEvent } from '../../../../shared/ipc';
import { StructuredLogger } from '../../../../shared/node/logger';
import type { AgentLifecycleSignal } from '../contract';
import { AgentHookManager, MAX_AGENT_HOOK_CONFIG_BYTES } from '../manager';
import { codexHookAdapter } from '../../providers/codex/hooks';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

function parseHooks(source: string): Record<string, unknown[]> {
    const parsed: unknown = JSON.parse(source);
    if (typeof parsed !== 'object' || parsed === null || !('hooks' in parsed)) return {};
    const hooks = Reflect.get(parsed, 'hooks');
    return typeof hooks === 'object' && hooks !== null ? (hooks as Record<string, unknown[]>) : {};
}

afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
});

describe('AgentHookManager', () => {
    it('removes a stale hook socket left by a crashed Runtime for the same profile', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-hooks-stale-socket-'));
        temporaryDirectories.push(directory);
        const userDataPath = join(directory, 'profile');
        await mkdir(userDataPath, { recursive: true });
        const profileId = createHash('sha256').update(userDataPath).digest('hex').slice(0, 16);
        const staleSocketPath = join(tmpdir(), `caxri-hooks-${profileId}-2147483646.sock`);
        const staleServer = createServer();
        staleServer.listen(staleSocketPath);
        await once(staleServer, 'listening');
        const manager = new AgentHookManager({
            environment: { homeDirectory: directory, variables: {} },
            logger: new StructuredLogger(join(directory, 'logs')),
            onAuthorityLost: vi.fn(),
            onLaunchEnded: vi.fn(),
            onLaunchStarted: vi.fn(),
            onSignal: vi.fn(() => true),
            runtimeExecutable: process.execPath,
            send: vi.fn(),
            sharedPath: join(directory, 'shared'),
            userDataPath,
        });

        try {
            await manager.initialize(structuredClone(defaultAgentProviderSettings));

            await expect(lstat(staleSocketPath)).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
            await manager.close();
            await new Promise<void>((resolve) => staleServer.close(() => resolve()));
            await rm(staleSocketPath, { force: true });
        }
    });

    it('preserves hooks enabled by another Caxri profile', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-hooks-profiles-'));
        temporaryDirectories.push(directory);
        const codexHome = join(directory, 'codex');
        const claudeHome = join(directory, 'claude');
        const sharedPath = join(directory, 'shared');
        const profileCodex = join(directory, 'profile-codex');
        const profileClaude = join(directory, 'profile-claude');
        await Promise.all([
            mkdir(profileCodex, { recursive: true }),
            mkdir(profileClaude, { recursive: true }),
        ]);
        const environment = {
            homeDirectory: directory,
            variables: { CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome },
        };
        const createManager = (profile: string) =>
            new AgentHookManager({
                environment,
                logger: new StructuredLogger(join(directory, `logs-${profile}`)),
                onAuthorityLost: vi.fn(),
                onLaunchEnded: vi.fn(),
                onLaunchStarted: vi.fn(),
                onSignal: vi.fn(() => true),
                runtimeExecutable: process.execPath,
                send: vi.fn(),
                sharedPath,
                userDataPath: profile === 'profile-codex' ? profileCodex : profileClaude,
            });
        const codexSettings = structuredClone(defaultAgentProviderSettings);
        codexSettings.codex.hooks.enabled = true;
        const claudeSettings = structuredClone(defaultAgentProviderSettings);
        claudeSettings.claude.hooks.enabled = true;
        const codexManager = createManager('profile-codex');
        const claudeManager = createManager('profile-claude');

        try {
            await codexManager.initialize(codexSettings);
            await claudeManager.initialize(claudeSettings);

            expect(
                parseHooks(await readFile(join(codexHome, 'hooks.json'), 'utf8')),
            ).toHaveProperty('Stop');
            expect(
                parseHooks(await readFile(join(claudeHome, 'settings.json'), 'utf8')),
            ).toHaveProperty('Stop');

            claudeSettings.codex.hooks.enabled = true;
            await claudeManager.reconcile(claudeSettings);
            codexSettings.codex.hooks.enabled = false;
            await codexManager.reconcile(codexSettings);
            expect(
                parseHooks(await readFile(join(codexHome, 'hooks.json'), 'utf8')),
            ).toHaveProperty('Stop');

            claudeSettings.codex.hooks.enabled = false;
            await claudeManager.reconcile(claudeSettings);
            expect(parseHooks(await readFile(join(codexHome, 'hooks.json'), 'utf8'))).toEqual({});
        } finally {
            await Promise.all([codexManager.close(), claudeManager.close()]);
        }
    });

    it('does not repeat authority loss during unchanged mixed-profile reconciliation', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-hooks-authority-'));
        temporaryDirectories.push(directory);
        const codexHome = join(directory, 'codex');
        const claudeHome = join(directory, 'claude');
        const sharedPath = join(directory, 'shared');
        const ownerProfile = join(directory, 'profile-owner');
        const currentProfile = join(directory, 'profile-current');
        await Promise.all([
            mkdir(ownerProfile, { recursive: true }),
            mkdir(currentProfile, { recursive: true }),
        ]);
        const environment = {
            homeDirectory: directory,
            variables: { CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome },
        };
        const createManager = (userDataPath: string, onAuthorityLost = vi.fn()) =>
            new AgentHookManager({
                environment,
                logger: new StructuredLogger(join(userDataPath, 'logs')),
                onAuthorityLost,
                onLaunchEnded: vi.fn(),
                onLaunchStarted: vi.fn(),
                onSignal: vi.fn(() => true),
                runtimeExecutable: process.execPath,
                send: vi.fn(),
                sharedPath,
                userDataPath,
            });
        const ownerSettings = structuredClone(defaultAgentProviderSettings);
        ownerSettings.codex.hooks.enabled = true;
        const owner = createManager(ownerProfile);
        await owner.initialize(ownerSettings);
        await owner.close();

        const authorityLost = vi.fn();
        const currentSettings = structuredClone(defaultAgentProviderSettings);
        currentSettings.claude.hooks.enabled = true;
        const current = createManager(currentProfile, authorityLost);
        try {
            await current.initialize(currentSettings);
            const callsAfterInitialize = authorityLost.mock.calls.length;

            await current.reconcile(currentSettings);

            expect(authorityLost).toHaveBeenCalledTimes(callsAfterInitialize);
        } finally {
            await current.close();
        }
    });

    it('does not reconcile unchanged provider files every second', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-hooks-steady-state-'));
        temporaryDirectories.push(directory);
        const profile = join(directory, 'profile');
        await mkdir(profile, { recursive: true });
        const inspect = vi.spyOn(codexHookAdapter, 'inspect');
        const settings = structuredClone(defaultAgentProviderSettings);
        settings.codex.hooks.enabled = true;
        const manager = new AgentHookManager({
            environment: {
                homeDirectory: directory,
                variables: { CODEX_HOME: join(directory, 'codex') },
            },
            logger: new StructuredLogger(join(directory, 'logs')),
            onAuthorityLost: vi.fn(),
            onLaunchEnded: vi.fn(),
            onLaunchStarted: vi.fn(),
            onSignal: vi.fn(() => true),
            runtimeExecutable: process.execPath,
            send: vi.fn(),
            sharedPath: join(directory, 'shared'),
            userDataPath: profile,
        });

        try {
            await manager.initialize(settings);
            /** Allow the native watcher to deliver any event queued by the initial atomic install. */
            await new Promise((resolve) => setTimeout(resolve, 250));
            const callsAfterInitialize = inspect.mock.calls.length;

            await new Promise((resolve) => setTimeout(resolve, 1_100));

            expect(inspect).toHaveBeenCalledTimes(callsAfterInitialize);
        } finally {
            await manager.close();
        }
    });

    it('removes intents whose Caxri profile directory was deleted', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-hooks-stale-profile-'));
        temporaryDirectories.push(directory);
        const codexHome = join(directory, 'codex');
        const sharedPath = join(directory, 'shared');
        const staleProfile = join(directory, 'profile-stale');
        const currentProfile = join(directory, 'profile-current');
        await Promise.all([
            mkdir(staleProfile, { recursive: true }),
            mkdir(currentProfile, { recursive: true }),
        ]);
        const createManager = (userDataPath: string) =>
            new AgentHookManager({
                environment: { homeDirectory: directory, variables: { CODEX_HOME: codexHome } },
                logger: new StructuredLogger(join(userDataPath, 'logs')),
                onAuthorityLost: vi.fn(),
                onLaunchEnded: vi.fn(),
                onLaunchStarted: vi.fn(),
                onSignal: vi.fn(() => true),
                runtimeExecutable: process.execPath,
                send: vi.fn(),
                sharedPath,
                userDataPath,
            });
        const settings = structuredClone(defaultAgentProviderSettings);
        settings.codex.hooks.enabled = true;
        const staleManager = createManager(staleProfile);

        await staleManager.initialize(settings);
        await staleManager.close();
        await rm(staleProfile, { recursive: true, force: true });

        const currentManager = createManager(currentProfile);
        try {
            await currentManager.initialize(settings);
            settings.codex.hooks.enabled = false;
            await currentManager.reconcile(settings);

            expect(parseHooks(await readFile(join(codexHome, 'hooks.json'), 'utf8'))).toEqual({});
        } finally {
            await currentManager.close();
        }
    });

    it('installs, activates, and removes provider hooks through the shared bridge', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-hooks-'));
        temporaryDirectories.push(directory);
        const codexHome = join(directory, 'codex');
        const settings = structuredClone(defaultAgentProviderSettings);
        settings.codex.hooks.enabled = true;
        const events: RuntimeEvent[] = [];
        const signals = vi.fn((signal: AgentLifecycleSignal) => {
            void signal;
            return true;
        });
        const launches = vi.fn();
        const manager = new AgentHookManager({
            environment: {
                homeDirectory: directory,
                variables: { CODEX_HOME: codexHome },
            },
            logger: new StructuredLogger(join(directory, 'logs')),
            onAuthorityLost: vi.fn(),
            onLaunchEnded: vi.fn(),
            onLaunchStarted: launches,
            onSignal: signals,
            runtimeExecutable: process.execPath,
            send: (event) => events.push(event),
            sharedPath: join(directory, 'shared'),
            userDataPath: join(directory, 'profile'),
        });

        try {
            await manager.initialize(settings);
            expect(manager.getHealth().codex.kind).toBe('installedPending');
            const hooks = parseHooks(await readFile(join(codexHome, 'hooks.json'), 'utf8'));
            expect(hooks.UserPromptSubmit).toHaveLength(1);
            expect(hooks.PermissionRequest).toHaveLength(1);
            expect(hooks.Stop).toHaveLength(1);
            expect(hooks.PostToolUse).toEqual([expect.objectContaining({ matcher: '^Bash$' })]);

            const environment = manager.terminalEnvironment('terminal-1', 'codex');
            expect(launches).toHaveBeenCalledWith('terminal-1', environment.CAXRI_HOOK_LAUNCH_ID);
            const bridge = join(directory, 'shared', 'bin', 'caxri-agent-hook-bridge');
            await execFileAsync(
                bridge,
                [
                    '--source',
                    'caxri',
                    '--provider',
                    'codex',
                    '--phase',
                    'turnFinished',
                    '--schema',
                    '2',
                ],
                { env: { ...process.env, ...environment, CAXRI_HOOK_TOKEN: 'invalid' } },
            );
            expect(signals).not.toHaveBeenCalled();
            const result = await execFileAsync(
                bridge,
                [
                    '--source',
                    'caxri',
                    '--provider',
                    'codex',
                    '--phase',
                    'turnFinished',
                    '--schema',
                    '2',
                    '--reply',
                    'empty-json',
                ],
                { env: { ...process.env, ...environment } },
            );
            expect(result.stdout).toBe('{}\n');
            await vi.waitFor(() => expect(signals).toHaveBeenCalledTimes(1));
            expect(manager.getHealth().codex.kind).toBe('active');

            await writeFile(join(codexHome, 'hooks.json'), '{}\n', 'utf8');
            await manager.reconcile(settings);
            const repaired = parseHooks(await readFile(join(codexHome, 'hooks.json'), 'utf8'));
            expect(repaired.UserPromptSubmit).toHaveLength(1);
            expect(repaired.PostToolUse).toEqual([expect.objectContaining({ matcher: '^Bash$' })]);
            expect(manager.getHealth().codex.kind).toBe('installedPending');

            await execFileAsync(
                bridge,
                [
                    '--source',
                    'caxri',
                    '--provider',
                    'codex',
                    '--phase',
                    'shellToolFinished',
                    '--schema',
                    '2',
                ],
                { env: { ...process.env, ...environment } },
            );
            await vi.waitFor(() => expect(signals).toHaveBeenCalledTimes(2));
            expect(signals).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    launchId: environment.CAXRI_HOOK_LAUNCH_ID,
                    phase: 'shellToolFinished',
                    provider: 'codex',
                    terminalId: 'terminal-1',
                }),
            );
            expect(Object.keys(signals.mock.calls.at(-1)?.[0] ?? {}).sort()).toEqual([
                'launchId',
                'phase',
                'protocolVersion',
                'provider',
                'schemaVersion',
                'terminalId',
                'token',
            ]);

            settings.codex.hooks.enabled = false;
            await manager.reconcile(settings);
            expect(manager.getHealth().codex.kind).toBe('notInstalled');
            expect(JSON.parse(await readFile(join(codexHome, 'hooks.json'), 'utf8'))).toEqual({});
            await execFileAsync(
                bridge,
                [
                    '--source',
                    'caxri',
                    '--provider',
                    'codex',
                    '--phase',
                    'turnFinished',
                    '--schema',
                    '2',
                ],
                { env: { ...process.env, ...environment } },
            );
            expect(signals).toHaveBeenCalledTimes(2);
            expect(events.some((event) => event.event === 'agentHooks.changed')).toBe(true);
        } finally {
            await manager.close();
        }
    });

    it('does not rewrite a malformed provider hook tree', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-hooks-malformed-'));
        temporaryDirectories.push(directory);
        const codexHome = join(directory, 'codex');
        await mkdir(codexHome, { recursive: true });
        const hooksPath = join(codexHome, 'hooks.json');
        const malformed = '{ "hooks": false }\n';
        await writeFile(hooksPath, malformed, 'utf8');
        const settings = structuredClone(defaultAgentProviderSettings);
        settings.codex.hooks.enabled = true;
        const manager = new AgentHookManager({
            environment: { homeDirectory: directory, variables: { CODEX_HOME: codexHome } },
            logger: new StructuredLogger(join(directory, 'logs')),
            onAuthorityLost: vi.fn(),
            onLaunchEnded: vi.fn(),
            onLaunchStarted: vi.fn(),
            onSignal: vi.fn(() => true),
            runtimeExecutable: process.execPath,
            send: vi.fn(),
            sharedPath: join(directory, 'shared'),
            userDataPath: join(directory, 'profile'),
        });

        try {
            await manager.initialize(settings);

            expect(manager.getHealth().codex.kind).toBe('error');
            expect(await readFile(hooksPath, 'utf8')).toBe(malformed);
        } finally {
            await manager.close();
        }
    });

    it('inspects and reconciles a symlinked foreign Codex hook policy without rewriting it', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-hooks-symlink-'));
        temporaryDirectories.push(directory);
        const codexHome = join(directory, 'codex');
        const managedConfig = join(directory, 'dotfiles', 'config.toml');
        const configPath = join(codexHome, 'config.toml');
        const hooksPath = join(codexHome, 'hooks.json');
        const foreignConfig = '[[hooks.Stop]]\ncommand = "foreign"\n';
        await mkdir(codexHome, { recursive: true });
        await mkdir(join(directory, 'dotfiles'), { recursive: true });
        await writeFile(managedConfig, foreignConfig, 'utf8');
        await symlink(managedConfig, configPath);
        const settings = structuredClone(defaultAgentProviderSettings);
        settings.codex.hooks.enabled = true;
        const manager = new AgentHookManager({
            environment: { homeDirectory: directory, variables: { CODEX_HOME: codexHome } },
            logger: new StructuredLogger(join(directory, 'logs')),
            onAuthorityLost: vi.fn(),
            onLaunchEnded: vi.fn(),
            onLaunchStarted: vi.fn(),
            onSignal: vi.fn(() => true),
            runtimeExecutable: process.execPath,
            send: vi.fn(),
            sharedPath: join(directory, 'shared'),
            userDataPath: join(directory, 'profile'),
        });

        try {
            await manager.initialize(settings);
            await manager.reconcile(settings);

            expect(manager.getHealth().codex).toEqual({
                kind: 'conflict',
                message: 'Codex already defines inline hooks in config.toml',
            });
            expect(await readFile(managedConfig, 'utf8')).toBe(foreignConfig);
            expect((await lstat(configPath)).isSymbolicLink()).toBe(true);
            await expect(lstat(hooksPath)).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
            await manager.close();
        }
    });

    it('rejects an oversized Codex hook config before any adapter can inspect or rewrite it', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-hooks-oversized-'));
        temporaryDirectories.push(directory);
        const codexHome = join(directory, 'codex');
        await mkdir(codexHome, { recursive: true });
        const hooksPath = join(codexHome, 'hooks.json');
        const oversized = `{"hooks":{},"padding":"${'x'.repeat(MAX_AGENT_HOOK_CONFIG_BYTES)}"}\n`;
        await writeFile(hooksPath, oversized, 'utf8');
        const inspect = vi.spyOn(codexHookAdapter, 'inspect');
        const render = vi.spyOn(codexHookAdapter, 'render');
        const remove = vi.spyOn(codexHookAdapter, 'remove');
        const settings = structuredClone(defaultAgentProviderSettings);
        settings.codex.hooks.enabled = true;
        const manager = new AgentHookManager({
            environment: { homeDirectory: directory, variables: { CODEX_HOME: codexHome } },
            logger: new StructuredLogger(join(directory, 'logs')),
            onAuthorityLost: vi.fn(),
            onLaunchEnded: vi.fn(),
            onLaunchStarted: vi.fn(),
            onSignal: vi.fn(() => true),
            runtimeExecutable: process.execPath,
            send: vi.fn(),
            sharedPath: join(directory, 'shared'),
            userDataPath: join(directory, 'profile'),
        });

        try {
            await manager.initialize(settings);

            expect(inspect).not.toHaveBeenCalled();
            expect(render).not.toHaveBeenCalled();
            expect(remove).not.toHaveBeenCalled();
            expect(await readFile(hooksPath, 'utf8')).toBe(oversized);
            const health = manager.getHealth().codex;
            expect(health.kind).toBe('error');
            if (health.kind === 'error') expect(health.message).toContain('exceeds');
        } finally {
            await manager.close();
        }
    });

    it('never downgrades or uninstalls entries owned by a newer Caxri schema', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-hooks-newer-'));
        temporaryDirectories.push(directory);
        const codexHome = join(directory, 'codex');
        await mkdir(codexHome, { recursive: true });
        const newerSource = `${JSON.stringify(
            {
                hooks: {
                    Stop: [
                        {
                            hooks: [
                                {
                                    type: 'command',
                                    command:
                                        "'/newer/bridge' --source caxri --provider codex --phase turnFinished --schema 3",
                                    timeout: 1,
                                },
                            ],
                        },
                    ],
                },
            },
            null,
            2,
        )}\n`;
        const hooksPath = join(codexHome, 'hooks.json');
        await writeFile(hooksPath, newerSource, 'utf8');
        const settings = structuredClone(defaultAgentProviderSettings);
        settings.codex.hooks.enabled = true;
        const manager = new AgentHookManager({
            environment: { homeDirectory: directory, variables: { CODEX_HOME: codexHome } },
            logger: new StructuredLogger(join(directory, 'logs')),
            onAuthorityLost: vi.fn(),
            onLaunchEnded: vi.fn(),
            onLaunchStarted: vi.fn(),
            onSignal: vi.fn(() => true),
            runtimeExecutable: process.execPath,
            send: vi.fn(),
            sharedPath: join(directory, 'shared'),
            userDataPath: join(directory, 'profile'),
        });

        try {
            await manager.initialize(settings);
            expect(manager.getHealth().codex.kind).toBe('newer');
            expect(await readFile(hooksPath, 'utf8')).toBe(newerSource);

            await writeFile(
                join(codexHome, 'config.toml'),
                '[[hooks.Stop]]\ncommand = "foreign"\n',
                'utf8',
            );
            settings.codex.hooks.enabled = false;
            await manager.reconcile(settings);
            expect(await readFile(hooksPath, 'utf8')).toBe(newerSource);
        } finally {
            await manager.close();
        }
    });
});
