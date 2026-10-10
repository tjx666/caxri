import {
    chmod,
    lstat,
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    readlink,
    rm,
    stat,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { defaultAgentProviderSettings } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentHookManager } from '../manager';

const temporaryDirectories: string[] = [];
const loggers: StructuredLogger[] = [];

afterEach(async () => {
    vi.restoreAllMocks();
    const pendingLoggers = [...loggers];
    loggers.length = 0;
    await Promise.all(pendingLoggers.map((logger) => logger.flush()));
    const pendingCleanup = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(pendingCleanup.map((path) => rm(path, { recursive: true, force: true })));
});

function createManager(directory: string, variables: Record<string, string>): AgentHookManager {
    const logger = new StructuredLogger(join(directory, 'logs'), 'server-core', 'info');
    loggers.push(logger);
    return new AgentHookManager({
        environment: { homeDirectory: directory, variables },
        logger,
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
}

function claudeOnlySettings(): typeof defaultAgentProviderSettings {
    const settings = structuredClone(defaultAgentProviderSettings);
    settings.claude.hooks.enabled = true;
    settings.codex.hooks.enabled = false;
    settings.grok.hooks.enabled = false;
    return settings;
}

async function temporaryFiles(...directories: string[]): Promise<string[]> {
    const entries = await Promise.all(directories.map((directory) => readdir(directory)));
    return entries.flat().filter((name) => name.endsWith('.tmp'));
}

/**
 * Provider configs are often symlinks into a dotfiles repository. Reads follow the final link, so installs and repairs
 * must write through it too: replacing the link with a standalone file silently forks the config from its source.
 */
describe('AgentHookManager symlinked provider config', () => {
    it('installs Caxri hooks into the target of a symlinked Claude settings.json and keeps the link', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-hooks-claude-link-'));
        temporaryDirectories.push(directory);
        const claudeHome = join(directory, 'claude');
        const dotfiles = join(directory, 'dotfiles');
        const managedSettings = join(dotfiles, 'claude-settings.json');
        const configPath = join(claudeHome, 'settings.json');
        await Promise.all([
            mkdir(claudeHome, { recursive: true }),
            mkdir(dotfiles, { recursive: true }),
        ]);
        await writeFile(managedSettings, '{ "theme": "dark" }\n', 'utf8');
        await chmod(managedSettings, 0o644);
        await symlink(managedSettings, configPath);
        const manager = createManager(directory, { CLAUDE_CONFIG_DIR: claudeHome });

        try {
            await manager.initialize(claudeOnlySettings());

            expect(manager.getHealth().claude.kind).toBe('installedPending');
            expect((await lstat(configPath)).isSymbolicLink()).toBe(true);
            expect(await readlink(configPath)).toBe(managedSettings);
            const installed = JSON.parse(await readFile(managedSettings, 'utf8')) as {
                hooks?: Record<string, unknown>;
                theme?: string;
            };
            expect(installed.theme).toBe('dark');
            expect(installed.hooks).toHaveProperty('Stop');
            expect(JSON.stringify(installed.hooks)).toContain('--source caxri');
            expect((await stat(managedSettings)).mode & 0o777).toBe(0o644);
            expect(await temporaryFiles(claudeHome, dotfiles)).toEqual([]);
        } finally {
            await manager.close();
        }
    });

    it('refuses to replace a dangling Claude settings.json symlink', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-hooks-claude-dangling-'));
        temporaryDirectories.push(directory);
        const claudeHome = join(directory, 'claude');
        const missingSettings = join(directory, 'dotfiles', 'claude-settings.json');
        const configPath = join(claudeHome, 'settings.json');
        await mkdir(claudeHome, { recursive: true });
        await symlink(missingSettings, configPath);
        const manager = createManager(directory, { CLAUDE_CONFIG_DIR: claudeHome });

        try {
            await manager.initialize(claudeOnlySettings());

            expect(manager.getHealth().claude).toEqual({
                kind: 'error',
                message:
                    'settings.json is a symlink to a missing file. Restore the link target or remove the link.',
            });
            expect((await lstat(configPath)).isSymbolicLink()).toBe(true);
            expect(await readlink(configPath)).toBe(missingSettings);
            await expect(lstat(missingSettings)).rejects.toMatchObject({ code: 'ENOENT' });
            expect(await temporaryFiles(claudeHome)).toEqual([]);
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
        const manager = createManager(directory, { CODEX_HOME: codexHome });

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
});
