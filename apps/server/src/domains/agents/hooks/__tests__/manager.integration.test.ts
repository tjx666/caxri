import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { ServerEvent } from '@caxri/protocol';
import { defaultAgentProviderSettings } from '@caxri/protocol';
import { execFileAsync, StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { codexHookAdapter } from '../../providers/codex/hooks';
import type { AgentLifecycleSignal, AgentSignalDecision } from '../contract';
import { AgentHookManager, MAX_AGENT_HOOK_CONFIG_BYTES } from '../manager';
import { hookBridgeEnvironment } from './server.fixture';

const loggers: StructuredLogger[] = [];

function createLogger(...arguments_: ConstructorParameters<typeof StructuredLogger>) {
    const logger = new StructuredLogger(...arguments_);
    loggers.push(logger);
    return logger;
}

async function flushLoggers(): Promise<void> {
    const pendingLoggers = [...loggers];
    loggers.length = 0;
    await Promise.all(pendingLoggers.map((logger) => logger.flush()));
}
const temporaryDirectories: string[] = [];

function parseHooks(source: string): Record<string, unknown[]> {
    const parsed: unknown = JSON.parse(source);
    if (typeof parsed !== 'object' || parsed === null || !('hooks' in parsed)) return {};
    const hooks = Reflect.get(parsed, 'hooks');
    return typeof hooks === 'object' && hooks !== null ? (hooks as Record<string, unknown[]>) : {};
}

async function readHooks(path: string): Promise<Record<string, unknown[]>> {
    return parseHooks(await readFile(path, 'utf8'));
}

afterEach(async () => {
    vi.restoreAllMocks();
    await flushLoggers();
    const pendingCleanup = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(pendingCleanup.map((path) => rm(path, { recursive: true, force: true })));
});

describe('AgentHookManager', () => {
    it('removes a stale hook socket left by a crashed Server Core for the same profile', async () => {
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
            logger: createLogger(join(directory, 'logs')),
            onAuthorityLost: vi.fn(),
            onLaunchEnded: vi.fn(),
            onLaunchStarted: vi.fn(),
            onSignal: vi.fn(() => 'accepted' as const),
            discoverExecutable: () => Promise.resolve(process.execPath),
            hookExecutable: process.execPath,
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
                logger: createLogger(join(directory, `logs-${profile}`)),
                onAuthorityLost: vi.fn(),
                onLaunchEnded: vi.fn(),
                onLaunchStarted: vi.fn(),
                onSignal: vi.fn(() => 'accepted' as const),
                discoverExecutable: () => Promise.resolve(process.execPath),
                hookExecutable: process.execPath,
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

            expect(await readHooks(join(codexHome, 'hooks.json'))).toHaveProperty('Stop');
            expect(await readHooks(join(claudeHome, 'settings.json'))).toHaveProperty('Stop');

            claudeSettings.codex.hooks.enabled = true;
            await claudeManager.reconcile(claudeSettings);
            codexSettings.codex.hooks.enabled = false;
            await codexManager.reconcile(codexSettings);
            expect(await readHooks(join(codexHome, 'hooks.json'))).toHaveProperty('Stop');

            claudeSettings.codex.hooks.enabled = false;
            await claudeManager.reconcile(claudeSettings);
            expect(await readHooks(join(codexHome, 'hooks.json'))).toEqual({});
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
                logger: createLogger(join(userDataPath, 'logs')),
                onAuthorityLost,
                onLaunchEnded: vi.fn(),
                onLaunchStarted: vi.fn(),
                onSignal: vi.fn(() => 'accepted' as const),
                discoverExecutable: () => Promise.resolve(process.execPath),
                hookExecutable: process.execPath,
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

    it('waits for a missing provider CLI instead of writing into its configuration', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-hooks-missing-cli-'));
        temporaryDirectories.push(directory);
        const codexHome = join(directory, 'codex');
        const claudeHome = join(directory, '.claude');
        const settings = structuredClone(defaultAgentProviderSettings);
        settings.codex.hooks.enabled = true;
        settings.claude.hooks.enabled = true;
        const discovered: string[] = [];
        const send = vi.fn();
        const manager = new AgentHookManager({
            environment: { homeDirectory: directory, variables: { CODEX_HOME: codexHome } },
            logger: createLogger(join(directory, 'logs')),
            onAuthorityLost: vi.fn(),
            onLaunchEnded: vi.fn(),
            onLaunchStarted: vi.fn(),
            onSignal: vi.fn(() => 'accepted' as const),
            discoverExecutable: (provider, executable) => {
                discovered.push(`${provider}:${executable}`);
                return Promise.resolve(provider === 'claude' ? process.execPath : undefined);
            },
            hookExecutable: process.execPath,
            send,
            sharedPath: join(directory, 'shared'),
            userDataPath: join(directory, 'profile'),
        });

        try {
            await manager.initialize(settings);

            expect(discovered).toEqual(expect.arrayContaining(['codex:codex', 'claude:claude']));
            // A steady-state reconcile must not flap the missing provider's health or re-announce it.
            const healthEventsAfterInitialize = send.mock.calls.length;
            await manager.reconcile(structuredClone(settings));
            expect(send.mock.calls.length).toBe(healthEventsAfterInitialize);
            expect(await readHooks(join(claudeHome, 'settings.json'))).toHaveProperty('Stop');
            await expect(lstat(join(codexHome, 'hooks.json'))).rejects.toMatchObject({
                code: 'ENOENT',
            });
            expect(manager.getHealth().codex).toEqual({
                kind: 'notInstalled',
                message: 'Install the Codex CLI, then restart Caxri.',
            });
            expect(manager.getHealth().claude.kind).toBe('installedPending');
            const registry = JSON.parse(
                await readFile(join(directory, 'shared', 'profile-intents.json'), 'utf8'),
            ) as { profiles: Record<string, { providers: string[] }> };
            expect(Object.values(registry.profiles).flatMap((entry) => entry.providers)).toEqual([
                'claude',
                'codex',
            ]);
        } finally {
            await manager.close();
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
            logger: createLogger(join(directory, 'logs')),
            onAuthorityLost: vi.fn(),
            onLaunchEnded: vi.fn(),
            onLaunchStarted: vi.fn(),
            onSignal: vi.fn(() => 'accepted' as const),
            discoverExecutable: () => Promise.resolve(process.execPath),
            hookExecutable: process.execPath,
            send: vi.fn(),
            sharedPath: join(directory, 'shared'),
            userDataPath: profile,
        });

        try {
            await manager.initialize(settings);
            /**
             * The native watcher can still deliver the initial atomic install's event after `initialize` resolves, and
             * its latency is not bounded under a loaded host; a fixed 250ms grace let that one event land inside the
             * measured window. Wait until reconciles go quiet instead, then measure.
             */
            await vi.waitUntil(
                async () => {
                    const calls = inspect.mock.calls.length;
                    await new Promise((resolve) => setTimeout(resolve, 600));
                    return inspect.mock.calls.length === calls;
                },
                { timeout: 5_000 },
            );
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
                logger: createLogger(join(userDataPath, 'logs')),
                onAuthorityLost: vi.fn(),
                onLaunchEnded: vi.fn(),
                onLaunchStarted: vi.fn(),
                onSignal: vi.fn(() => 'accepted' as const),
                discoverExecutable: () => Promise.resolve(process.execPath),
                hookExecutable: process.execPath,
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

            expect(await readHooks(join(codexHome, 'hooks.json'))).toEqual({});
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
        const events: ServerEvent[] = [];
        const signals = vi.fn<(signal: AgentLifecycleSignal) => AgentSignalDecision>(
            () => 'accepted',
        );
        const launches = vi.fn();
        const logger = createLogger(join(directory, 'logs'), 'server-core', 'info');
        const manager = new AgentHookManager({
            environment: {
                homeDirectory: directory,
                variables: { CODEX_HOME: codexHome },
            },
            logger,
            onAuthorityLost: vi.fn(),
            onLaunchEnded: vi.fn(),
            onLaunchStarted: launches,
            onSignal: signals,
            discoverExecutable: () => Promise.resolve(process.execPath),
            hookExecutable: process.execPath,
            send: (event) => {
                events.push(event);
            },
            sharedPath: join(directory, 'shared'),
            userDataPath: join(directory, 'profile'),
        });

        try {
            await manager.initialize(settings);
            expect(manager.getHealth().codex.kind).toBe('installedPending');
            const hooks = parseHooks(await readFile(join(codexHome, 'hooks.json'), 'utf8'));
            expect(hooks.UserPromptSubmit).toHaveLength(1);
            expect(hooks.SessionStart).toHaveLength(1);
            expect(hooks.PermissionRequest).toHaveLength(1);
            expect(hooks.Stop).toHaveLength(1);
            expect(hooks.PreToolUse).toHaveLength(2);
            expect(hooks.PostToolUse).toHaveLength(2);
            expect(hooks.PreCompact).toHaveLength(1);
            expect(hooks.PostCompact).toHaveLength(1);

            const environment = manager.terminalEnvironment('terminal-1', 'codex');
            expect(launches).toHaveBeenCalledWith('terminal-1', environment.CAXRI_HOOK_LAUNCH_ID);
            const bridge = join(directory, 'shared', 'bin', 'caxri-agent-hook-bridge');
            const rejected = await execFileAsync(
                bridge,
                ['--source', 'caxri', '--provider', 'codex', '--phase', 'turnFinished'],
                {
                    env: hookBridgeEnvironment(environment, {
                        CAXRI_HOOK_TOKEN: 'test-token-never-log',
                    }),
                },
            );
            expect(rejected.stderr).toBe('caxri-hook: signal_rejected\n');
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
                    '--reply',
                    'empty-json',
                ],
                { env: hookBridgeEnvironment(environment) },
            );
            expect(result.stdout).toBe('{}\n');
            await vi.waitFor(() => expect(signals).toHaveBeenCalledTimes(1));
            expect(manager.getHealth().codex.kind).toBe('active');

            /**
             * A provider hook payload contributes only opaque identifiers and bounded local classifications.
             */
            const payloadInvocation = execFileAsync(
                bridge,
                ['--source', 'caxri', '--provider', 'codex', '--phase', 'turnStarted'],
                { env: hookBridgeEnvironment(environment) },
            );
            payloadInvocation.child.stdin?.end(
                JSON.stringify({
                    session_id: 'codex-session-123',
                    turn_id: 'codex-turn-456',
                    prompt: 'never forwarded',
                }),
            );
            await payloadInvocation;
            await vi.waitFor(() => expect(signals).toHaveBeenCalledTimes(2));
            expect(signals).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    agentSessionId: 'codex-session-123',
                    agentTurnId: 'codex-turn-456',
                }),
            );
            expect(signals.mock.calls.at(-1)?.[0]).not.toHaveProperty('prompt');

            await execFileAsync(
                bridge,
                ['--source', 'caxri', '--provider', 'codex', '--phase', 'turnStarted'],
                { env: hookBridgeEnvironment(environment) },
            );
            await vi.waitFor(() => expect(signals).toHaveBeenCalledTimes(3));

            signals.mockReturnValueOnce('staleLaunch');
            const ignored = await execFileAsync(
                bridge,
                ['--source', 'caxri', '--provider', 'codex', '--phase', 'sessionIdentified'],
                { env: hookBridgeEnvironment(environment) },
            );
            expect(ignored.stderr).toBe('');
            await vi.waitFor(() => expect(signals).toHaveBeenCalledTimes(4));

            /**
             * A nested CLI (e.g. Claude Code shelling out to `codex`) inherits the parent Terminal's CAXRI_HOOK_*
             * environment, so its own hook fires with the parent's token but its own provider id. That must be treated
             * as an ignored, benign signal rather than a rejection: the bridge should not print `caxri-hook:
             * signal_rejected` to the nested CLI's stderr, and `onSignal` must not be invoked for it.
             */
            const providerMismatch = await execFileAsync(
                bridge,
                ['--source', 'caxri', '--provider', 'claude', '--phase', 'turnFinished'],
                { env: hookBridgeEnvironment(environment) },
            );
            expect(providerMismatch.stderr).toBe('');
            expect(signals).toHaveBeenCalledTimes(4);

            await logger.flush();
            const logSource = await readFile(join(directory, 'logs', 'server-core.jsonl'), 'utf8');
            const logRecords = logSource
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line) as Record<string, unknown>);
            const rejectedLog = logRecords.find(
                (record) => record.event === 'agent_hooks.signal_rejected',
            );
            const acceptedLogs = logRecords.filter(
                (record) => record.event === 'agent_hooks.signal_accepted',
            );
            const bridgeStartedLog = logRecords.find(
                (record) => record.event === 'agent_hooks.bridge_started',
            );
            const launchPreparedLog = logRecords.find(
                (record) => record.event === 'agent_hooks.launch_prepared',
            );
            const acceptedIdentityLog = acceptedLogs.find(
                (record) =>
                    (record.fields as Record<string, unknown> | undefined)?.hasAgentSessionId ===
                    true,
            );
            const ignoredLog = logRecords.find(
                (record) => record.event === 'agent_hooks.signal_ignored',
            );
            expect(rejectedLog).toMatchObject({
                fields: { reason: 'unknownToken', stage: 'serverCore' },
            });
            expect(bridgeStartedLog).toMatchObject({
                fields: { provider: 'codex', stage: 'serverCore', terminalId: 'terminal-1' },
            });
            expect(launchPreparedLog).toMatchObject({
                fields: { provider: 'codex', stage: 'serverCore', terminalId: 'terminal-1' },
            });
            expect(acceptedIdentityLog).toMatchObject({
                fields: { hasAgentSessionId: true, stage: 'serverCore' },
            });
            expect(acceptedLogs).toHaveLength(3);
            // A downstream drop must name its cause: without the reason this record is indistinguishable from the
            // benign nested-CLI mismatch asserted below.
            expect(ignoredLog).toMatchObject({
                fields: {
                    phase: 'sessionIdentified',
                    reason: 'staleLaunch',
                    stage: 'serverCore',
                },
            });
            const providerMismatchLog = logRecords.find(
                (record) =>
                    record.event === 'agent_hooks.signal_ignored' &&
                    (record.fields as Record<string, unknown> | undefined)?.reason ===
                        'providerMismatch',
            );
            expect(providerMismatchLog).toMatchObject({
                fields: { provider: 'claude', reason: 'providerMismatch', stage: 'serverCore' },
            });
            expect(
                logRecords.some(
                    (record) =>
                        record.event === 'agent_hooks.signal_rejected' &&
                        (record.fields as Record<string, unknown> | undefined)?.reason ===
                            'providerMismatch',
                ),
            ).toBe(false);
            expect(logSource).not.toContain('test-token-never-log');
            expect(logSource).not.toContain('codex-session-123');
            expect(logSource).not.toContain('never forwarded');

            await writeFile(join(codexHome, 'hooks.json'), '{}\n', 'utf8');
            await manager.reconcile(settings);
            const repaired = parseHooks(await readFile(join(codexHome, 'hooks.json'), 'utf8'));
            expect(repaired.UserPromptSubmit).toHaveLength(1);
            expect(repaired.PostToolUse).toHaveLength(2);
            expect(manager.getHealth().codex.kind).toBe('installedPending');

            settings.codex.hooks.enabled = false;
            await manager.reconcile(settings);
            expect(manager.getHealth().codex.kind).toBe('notInstalled');
            expect(await readHooks(join(codexHome, 'hooks.json'))).toEqual({});
            await execFileAsync(
                bridge,
                ['--source', 'caxri', '--provider', 'codex', '--phase', 'turnFinished'],
                { env: hookBridgeEnvironment(environment) },
            );
            expect(signals).toHaveBeenCalledTimes(4);
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
            logger: createLogger(join(directory, 'logs')),
            onAuthorityLost: vi.fn(),
            onLaunchEnded: vi.fn(),
            onLaunchStarted: vi.fn(),
            onSignal: vi.fn(() => 'accepted' as const),
            discoverExecutable: () => Promise.resolve(process.execPath),
            hookExecutable: process.execPath,
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

    it("preserves a user's own Claude session-naming hook while installing Caxri entries", async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-hooks-personal-hook-'));
        temporaryDirectories.push(directory);
        const claudeHome = join(directory, '.claude');
        const hooksPath = join(claudeHome, 'settings.json');
        await mkdir(claudeHome, { recursive: true });
        await writeFile(
            hooksPath,
            JSON.stringify({
                hooks: {
                    Stop: [
                        {
                            hooks: [
                                {
                                    type: 'command',
                                    command: join(claudeHome, 'hooks', 'session-title-rename.js'),
                                },
                            ],
                        },
                    ],
                },
            }),
            'utf8',
        );
        const settings = structuredClone(defaultAgentProviderSettings);
        settings.claude.hooks.enabled = true;
        const manager = new AgentHookManager({
            environment: { homeDirectory: directory, variables: {} },
            logger: createLogger(join(directory, 'logs')),
            onAuthorityLost: vi.fn(),
            onLaunchEnded: vi.fn(),
            onLaunchStarted: vi.fn(),
            onSignal: vi.fn(() => 'accepted' as const),
            discoverExecutable: () => Promise.resolve(process.execPath),
            hookExecutable: process.execPath,
            send: vi.fn(),
            sharedPath: join(directory, 'shared'),
            userDataPath: join(directory, 'profile'),
        });

        try {
            await manager.initialize(settings);

            expect(manager.getHealth().claude.kind).toBe('installedPending');
            const installed = await readFile(hooksPath, 'utf8');
            expect(installed).toContain('session-title-rename.js');
            expect(installed).toContain('--source caxri');
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
            logger: createLogger(join(directory, 'logs')),
            onAuthorityLost: vi.fn(),
            onLaunchEnded: vi.fn(),
            onLaunchStarted: vi.fn(),
            onSignal: vi.fn(() => 'accepted' as const),
            discoverExecutable: () => Promise.resolve(process.execPath),
            hookExecutable: process.execPath,
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

    it('never downgrades or uninstalls entries owned by a newer Caxri schema, even behind a conflict', async () => {
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
                                        "'/newer/bridge' --source caxri --provider codex --phase turnFinished --schema 99",
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
            logger: createLogger(join(directory, 'logs')),
            onAuthorityLost: vi.fn(),
            onLaunchEnded: vi.fn(),
            onLaunchStarted: vi.fn(),
            onSignal: vi.fn(() => 'accepted' as const),
            discoverExecutable: () => Promise.resolve(process.execPath),
            hookExecutable: process.execPath,
            send: vi.fn(),
            sharedPath: join(directory, 'shared'),
            userDataPath: join(directory, 'profile'),
        });

        try {
            await manager.initialize(settings);
            expect(manager.getHealth().codex).toMatchObject({
                kind: 'incompatible',
                installedSchema: 99,
            });
            expect(await readFile(hooksPath, 'utf8')).toBe(newerSource);
            await execFileAsync(
                join(directory, 'shared', 'bin', 'caxri-agent-hook-bridge'),
                ['--source', 'caxri', '--provider', 'codex', '--phase', 'turnFinished'],
                {
                    env: hookBridgeEnvironment(
                        manager.terminalEnvironment('newer-terminal', 'codex'),
                    ),
                },
            );
            expect(manager.getHealth().codex.kind).toBe('incompatible');

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
