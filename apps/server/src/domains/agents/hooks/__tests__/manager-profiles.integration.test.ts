import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { defaultAgentProviderSettings } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentHookManager } from '../manager';

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

/**
 * Several Caxri profiles (a packaged app and worktree dev instances) share one provider hook file; each keeps or drops
 * only the entries a live profile still wants.
 */
describe('AgentHookManager across Caxri profiles', () => {
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
        const profileLoggers = new Map<string, StructuredLogger>();
        const createManager = (userDataPath: string) => {
            const logger = createLogger(join(userDataPath, 'logs'));
            profileLoggers.set(userDataPath, logger);
            return new AgentHookManager({
                environment: { homeDirectory: directory, variables: { CODEX_HOME: codexHome } },
                logger,
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
        };
        const settings = structuredClone(defaultAgentProviderSettings);
        settings.codex.hooks.enabled = true;
        const staleManager = createManager(staleProfile);

        await staleManager.initialize(settings);
        await staleManager.close();
        // A drain still pending after the delete recreates `profile-stale/logs`, which reads as a live profile.
        await profileLoggers.get(staleProfile)?.flush();
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
});
