import {
    chmod,
    lstat,
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    readlink,
    realpath,
    rename,
    rm,
    stat,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { defaultAgentProviderSettings } from '@caxri/protocol';
import { execFileAsync, StructuredLogger } from '@caxri/system';
import parcelWatcher from '@parcel/watcher';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WatchHub } from '../../../watch';
import type * as ConfigDocumentsModule from '../config-documents';
import { AgentHookManager } from '../manager';
import { hookBridgeEnvironment } from './server.fixture';

/**
 * Lets a test act right before the manager reads a provider config, which lands an edit between the manager's own hook
 * write and the re-read that follows it.
 */
const configReads = vi.hoisted(() => ({
    before: undefined as ((path: string) => Promise<void>) | undefined,
}));

vi.mock('../config-documents', async (importOriginal) => {
    const actual = await importOriginal<typeof ConfigDocumentsModule>();
    const readConfigDocuments: typeof actual.readConfigDocuments = async (targets, maxBytes) => {
        const { before } = configReads;
        if (before) await Promise.all(targets.map((target) => before(target.path)));
        return actual.readConfigDocuments(targets, maxBytes);
    };
    return { ...actual, readConfigDocuments };
});

const temporaryDirectories: string[] = [];
const loggers: StructuredLogger[] = [];

afterEach(async () => {
    vi.restoreAllMocks();
    configReads.before = undefined;
    const pendingLoggers = [...loggers];
    loggers.length = 0;
    await Promise.all(pendingLoggers.map((logger) => logger.flush()));
    const pendingCleanup = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(pendingCleanup.map((path) => rm(path, { recursive: true, force: true })));
});

function createManager(
    directory: string,
    variables: Record<string, string>,
    watchHub?: WatchHub,
): AgentHookManager {
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
        ...(watchHub && { watchHub }),
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
 * Watcher-driven reconciliation has no completion signal, and native event latency is unbounded on a loaded host, so
 * these waits poll the observable result instead of sleeping a fixed interval.
 */
const WATCHER_WAIT = { interval: 50, timeout: 10_000 } as const;

async function hasCaxriStopHook(path: string): Promise<boolean> {
    try {
        const settings = JSON.parse(await readFile(path, 'utf8')) as { hooks?: { Stop?: unknown } };
        return JSON.stringify(settings.hooks?.Stop ?? null).includes('--source caxri');
    } catch {
        return false;
    }
}

/**
 * A Claude settings.json symlinked into a dotfiles checkout. The link and its target use different basenames and
 * sibling directories so a watcher on the link's own directory can never observe a write to the target.
 */
async function linkedClaudeSettings(prefix: string, watchHub?: WatchHub) {
    const directory = await mkdtemp(join(tmpdir(), prefix));
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
    await symlink(managedSettings, configPath);
    const manager = createManager(directory, { CLAUDE_CONFIG_DIR: claudeHome }, watchHub);
    return { claudeHome, configPath, directory, dotfiles, managedSettings, manager };
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

    it('reports a dangling Claude settings.json symlink as a conflict without replacing it', async () => {
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

            /**
             * Restarting Agent Terminals cannot repair a link only the user can restore, so this is a `conflict` that
             * names the link rather than a retryable `error`.
             */
            expect(manager.getHealth().claude).toEqual({
                kind: 'conflict',
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

    it('repairs Caxri hooks that an edit to the symlink target removed', async () => {
        const { claudeHome, configPath, managedSettings, manager } = await linkedClaudeSettings(
            'caxri-agent-hooks-claude-target-edit-',
        );

        try {
            await manager.initialize(claudeOnlySettings());
            expect(await hasCaxriStopHook(managedSettings)).toBe(true);

            // A `git pull` in the dotfiles checkout rewrites the target; the link and its directory stay untouched.
            await writeFile(managedSettings, '{ "theme": "light" }\n', 'utf8');

            await vi.waitUntil(() => hasCaxriStopHook(managedSettings), WATCHER_WAIT);
            const repaired = JSON.parse(await readFile(managedSettings, 'utf8')) as {
                theme?: string;
            };
            expect(repaired.theme).toBe('light');
            expect(await readlink(configPath)).toBe(managedSettings);
            expect(await readdir(claudeHome)).toEqual(['settings.json']);
        } finally {
            await manager.close();
        }
    });

    it('turns a deleted symlink target into a conflict and recovers once the target returns', async () => {
        const { configPath, directory, managedSettings, manager } = await linkedClaudeSettings(
            'caxri-agent-hooks-claude-target-delete-',
        );
        const runBridge = async (environment: NodeJS.ProcessEnv): Promise<void> => {
            await execFileAsync(
                join(directory, 'shared', 'bin', 'caxri-agent-hook-bridge'),
                ['--source', 'caxri', '--provider', 'claude', '--phase', 'turnStarted'],
                { env: hookBridgeEnvironment(environment) },
            );
        };

        try {
            await manager.initialize(claudeOnlySettings());
            await runBridge(manager.terminalEnvironment('terminal-1', 'claude'));
            await vi.waitFor(() => expect(manager.getHealth().claude.kind).toBe('active'));

            await rm(managedSettings);

            await vi.waitFor(
                () =>
                    expect(manager.getHealth().claude).toEqual({
                        kind: 'conflict',
                        message:
                            'settings.json is a symlink to a missing file. Restore the link target or remove the link.',
                    }),
                WATCHER_WAIT,
            );
            expect(await readlink(configPath)).toBe(managedSettings);
            await expect(lstat(managedSettings)).rejects.toMatchObject({ code: 'ENOENT' });

            // Restoring the dotfiles copy brings back the user's settings without Caxri's entries.
            await writeFile(managedSettings, '{ "theme": "dark" }\n', 'utf8');

            await vi.waitFor(
                () => expect(manager.getHealth().claude.kind).toBe('installedPending'),
                WATCHER_WAIT,
            );
            expect(await hasCaxriStopHook(managedSettings)).toBe(true);
            expect((await lstat(configPath)).isSymbolicLink()).toBe(true);
            await runBridge(manager.terminalEnvironment('terminal-2', 'claude'));
            await vi.waitFor(() => expect(manager.getHealth().claude.kind).toBe('active'));
        } finally {
            await manager.close();
        }
    });

    it('follows a repointed settings.json symlink to its new target', async () => {
        const { configPath, directory, managedSettings, manager } = await linkedClaudeSettings(
            'caxri-agent-hooks-claude-repoint-',
        );
        const otherDotfiles = join(directory, 'other-dotfiles');
        const otherSettings = join(otherDotfiles, 'claude.json');
        await mkdir(otherDotfiles, { recursive: true });
        await writeFile(otherSettings, '{ "theme": "solarized" }\n', 'utf8');

        try {
            await manager.initialize(claudeOnlySettings());
            expect(await hasCaxriStopHook(managedSettings)).toBe(true);

            // Repoint atomically, as a dotfiles manager does; the watcher on the link's own directory observes it.
            await symlink(otherSettings, `${configPath}.next`);
            await rename(`${configPath}.next`, configPath);
            await vi.waitUntil(() => hasCaxriStopHook(otherSettings), WATCHER_WAIT);

            // The new target's directory is now watched as well: an edit there is repaired like any other.
            await writeFile(otherSettings, '{ "theme": "solarized-light" }\n', 'utf8');
            await vi.waitUntil(() => hasCaxriStopHook(otherSettings), WATCHER_WAIT);
            expect(await readlink(configPath)).toBe(otherSettings);
        } finally {
            await manager.close();
        }
    });

    /**
     * Pins the race a loaded host hits at random: the reconcile that follows a repoint writes the hook into the new
     * target and only then starts watching that target's directory, so an edit landing in between produces no event.
     * The edit lands either right before the manager re-reads its own write or inside the native subscribe call.
     * FSEvents can still attribute a write made just before a stream to that stream, which hides the race on an idle
     * host, so the new target directory's events are dropped: only the manager itself can notice the edit.
     */
    it.each(['reread', 'subscribe'] as const)(
        'repairs an edit that lands on a repointed target before its watcher is live (%s)',
        async (moment) => {
            const beforeSubscribe: { current?: (root: string) => Promise<boolean> } = {};
            const watchHub = new WatchHub({
                subscribe: async (root, callback, options) => {
                    const isRacedRoot = (await beforeSubscribe.current?.(root)) === true;
                    return parcelWatcher.subscribe(root, isRacedRoot ? vi.fn() : callback, options);
                },
            });
            const { configPath, directory, managedSettings, manager } = await linkedClaudeSettings(
                'caxri-agent-hooks-claude-repoint-race-',
                watchHub,
            );
            const otherDotfiles = join(directory, 'other-dotfiles');
            const otherSettings = join(otherDotfiles, 'claude.json');
            await mkdir(otherDotfiles, { recursive: true });
            await writeFile(otherSettings, '{ "theme": "solarized" }\n', 'utf8');
            const canonicalOtherDotfiles = await realpath(otherDotfiles);
            let racedEdits = 0;
            let isRacedEditWritten = false;
            /**
             * Edits the new target once, as soon as it holds the hook the repoint reconcile wrote.
             */
            const editOnce = async (): Promise<void> => {
                if (racedEdits > 0 || !(await hasCaxriStopHook(otherSettings))) return;
                racedEdits += 1;
                await writeFile(otherSettings, '{ "theme": "solarized-light" }\n', 'utf8');
                // `writeFile` truncates before writing, so the poll below must not parse the file until it is done.
                isRacedEditWritten = true;
            };
            beforeSubscribe.current = async (root) => {
                if (root !== canonicalOtherDotfiles) return false;
                if (moment === 'subscribe') await editOnce();
                return true;
            };
            if (moment === 'reread')
                configReads.before = async (path) => {
                    if (path === configPath) await editOnce();
                };

            try {
                await manager.initialize(claudeOnlySettings());
                expect(await hasCaxriStopHook(managedSettings)).toBe(true);

                await symlink(otherSettings, `${configPath}.next`);
                await rename(`${configPath}.next`, configPath);

                await vi.waitUntil(async () => {
                    if (!isRacedEditWritten) return false;
                    const settings = JSON.parse(await readFile(otherSettings, 'utf8')) as {
                        theme?: string;
                    };
                    return settings.theme === 'solarized-light' && hasCaxriStopHook(otherSettings);
                }, WATCHER_WAIT);
                expect(racedEdits).toBe(1);
            } finally {
                await manager.close();
                await watchHub.close();
            }
        },
    );

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
