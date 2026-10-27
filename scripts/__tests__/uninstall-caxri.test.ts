import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CaxriUninstallOptions } from '../uninstall-caxri';
import {
    parseUninstallArguments,
    removeGlobalCaxriCli,
    resolveUninstallTargets,
    uninstallCaxri,
} from '../uninstall-caxri';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const directoriesToRemove = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(
        directoriesToRemove.map((path) => rm(path, { force: true, recursive: true })),
    );
});

async function fixture(): Promise<{
    home: string;
    options: CaxriUninstallOptions;
    profile: string;
}> {
    const home = await mkdtemp(join(tmpdir(), 'caxri-uninstall-'));
    temporaryDirectories.push(home);
    const profile = join(home, 'Library', 'Application Support', 'Caxri');
    await mkdir(join(profile, 'host'), { recursive: true, mode: 0o700 });
    const options: CaxriUninstallOptions = {
        apply: false,
        archiveRootPath: join(home, 'code', 'caxri-uninstall-archives'),
        homeDirectory: home,
        includeDevProfiles: true,
        profilePath: profile,
        removeApplications: false,
        removeGlobalCli: true,
    };
    return { home, options, profile };
}

describe('Caxri uninstaller', () => {
    it('defaults to a dry run for the standard profile', () => {
        expect(
            parseUninstallArguments([], {}, '/Users/example', '/Users/example/code/caxri'),
        ).toEqual({
            apply: false,
            archiveRootPath: '/Users/example/code/caxri-uninstall-archives',
            environmentVariables: {},
            homeDirectory: '/Users/example',
            includeDevProfiles: true,
            profilePath: '/Users/example/Library/Application Support/Caxri',
            removeApplications: true,
            removeGlobalCli: true,
        });
    });

    it('accepts an explicit profile but rejects relative deletion targets', () => {
        expect(
            parseUninstallArguments(
                [
                    '--yes',
                    '--profile',
                    '/tmp/caxri-profile',
                    '--keep-app',
                    '--keep-cli',
                    '--keep-dev',
                ],
                {},
                '/Users/example',
                '/Users/example/code/caxri',
            ),
        ).toEqual({
            apply: true,
            archiveRootPath: '/Users/example/code/caxri-uninstall-archives',
            environmentVariables: {},
            homeDirectory: '/Users/example',
            includeDevProfiles: false,
            profilePath: '/tmp/caxri-profile',
            removeApplications: false,
            removeGlobalCli: false,
        });
        expect(() =>
            parseUninstallArguments(
                ['--profile', 'relative-profile'],
                {},
                '/Users/example',
                '/Users/example/code/caxri',
            ),
        ).toThrow('must be absolute');
        expect(() =>
            parseUninstallArguments(
                ['--profile', '/Users/example/Documents'],
                {},
                '/Users/example',
                '/Users/example/code/caxri',
            ),
        ).toThrow('must contain "caxri"');
    });

    it('treats an already absent global CLI as an idempotent uninstall', async () => {
        const runCommand = vi.fn(() =>
            Promise.resolve({
                stdout: JSON.stringify([{ dependencies: {}, path: '/global' }]),
            }),
        );

        await removeGlobalCaxriCli(runCommand);

        expect(runCommand).toHaveBeenCalledOnce();
        expect(runCommand).toHaveBeenCalledWith('pnpm', [
            'list',
            '--global',
            '--depth',
            '0',
            '--json',
            '@caxri/cli',
        ]);
    });

    it('preserves case-only profile variants until their filesystem identity is known', () => {
        const options = parseUninstallArguments(
            [],
            {},
            '/Users/example',
            '/Users/example/code/caxri',
        );
        if ('help' in options) throw new Error('Unexpected help result');
        const targets = resolveUninstallTargets(options);

        expect(targets).toContain('/Users/example/Library/Application Support/Caxri');
        expect(targets).toContain('/Users/example/Library/Application Support/caxri');
        expect(targets).toContain('/Users/example/Library/Application Support/caxri-dev');
        expect(
            targets.filter((path) =>
                path.toLowerCase().includes('/library/application support/caxri'),
            ),
        ).toHaveLength(3);
    });

    it('refuses to treat a Git worktree as a Caxri profile', async () => {
        const { home } = await fixture();
        const repo = join(home, 'code', 'caxri');
        await mkdir(join(repo, '.git'), { recursive: true });
        await writeFile(join(repo, 'caxri.db'), 'fixture', 'utf8');
        const options = parseUninstallArguments(
            ['--profile', repo, '--keep-app', '--keep-cli'],
            {},
            home,
            join(home, 'code', 'caxri'),
        );
        if ('help' in options) throw new Error('Unexpected help result');

        await expect(uninstallCaxri(options)).rejects.toThrow('Git worktree');
    });

    it('archives only profile-owned state without deriving a profile-external socket', async () => {
        const { options, profile } = await fixture();

        const result = await uninstallCaxri(
            { ...options, apply: true, removeGlobalCli: false },
            { inspectPathOwner: () => Promise.resolve(undefined) },
        );

        expect(result.targets).toEqual([profile]);
        expect(result.movedTargets).toEqual([profile]);
        expect(result.targets.some((path) => path.endsWith('.sock'))).toBe(false);
        expect(result.archiveDirectory?.startsWith(options.archiveRootPath)).toBe(true);
        expect(result.archiveDirectory).not.toContain(join(options.homeDirectory, '.Trash'));
    });

    it('does not infer an orphaned endpoint after the profile directory was removed', async () => {
        const { options, profile } = await fixture();
        await rm(profile, { force: true, recursive: true });

        const result = await uninstallCaxri(options, {
            inspectPathOwner: () => Promise.resolve(undefined),
            inspectProcess: () => Promise.resolve('/app/server/bundles/server-core.js'),
        });

        expect(result.hostPids).toEqual([]);
        expect(result.targets).toEqual([]);
    });

    it('keeps dry-run execution side-effect free', async () => {
        const { options, profile } = await fixture();
        await writeFile(join(profile, 'caxri.db'), 'fixture', 'utf8');
        await writeFile(join(profile, 'host', 'owner.lock'), JSON.stringify({ pid: 4242 }), {
            mode: 0o600,
        });
        const inspectProcess = vi.fn(() => Promise.resolve('/app/server/bundles/server-core.js'));
        const inspectPathOwner = vi.fn((path: string) =>
            Promise.resolve(path.endsWith('owner.lock') ? 4242 : undefined),
        );
        const signalProcess = vi.fn();
        const moveToArchive = vi.fn();
        const removeGlobalCli = vi.fn();

        const result = await uninstallCaxri(options, {
            inspectPathOwner,
            inspectProcess,
            moveToArchive,
            removeGlobalCli,
            signalProcess,
        });

        expect(result).toMatchObject({
            applied: false,
            cliRemoval: 'skipped',
            hostPids: [4242],
            targets: [profile],
        });
        expect(await readFile(join(profile, 'caxri.db'), 'utf8')).toBe('fixture');
        expect(inspectProcess).toHaveBeenCalledWith(4242);
        expect(signalProcess).not.toHaveBeenCalled();
        expect(moveToArchive).not.toHaveBeenCalled();
        expect(removeGlobalCli).not.toHaveBeenCalled();
    });

    it('gracefully stops the verified Host and records where local state was archived', async () => {
        const { options, profile } = await fixture();
        await writeFile(join(profile, 'host', 'owner.lock'), JSON.stringify({ pid: 4242 }), {
            mode: 0o600,
        });
        await writeFile(join(profile, 'caxri.db'), 'fixture', 'utf8');
        const signalProcess = vi.fn();
        const removeGlobalCli = vi.fn(() => Promise.resolve());

        const result = await uninstallCaxri(
            { ...options, apply: true },
            {
                inspectPathOwner: (path) =>
                    Promise.resolve(path.endsWith('owner.lock') ? 4242 : undefined),
                inspectProcess: () =>
                    Promise.resolve(
                        '/Applications/Caxri.app/Contents/Resources/server/runtime/bin/node /Applications/Caxri.app/Contents/Resources/server/bundles/server-core.js',
                    ),
                removeGlobalCli,
                signalProcess,
                waitForExit: () => Promise.resolve(true),
            },
        );

        expect(signalProcess).toHaveBeenCalledWith(4242, 'SIGTERM');
        expect(removeGlobalCli).toHaveBeenCalledOnce();
        expect(result).toMatchObject({
            applied: true,
            cliRemoval: 'removed',
            failedTargets: [],
            hostPids: [4242],
            movedTargets: [profile],
        });
        await expect(readFile(join(profile, 'caxri.db'), 'utf8')).rejects.toMatchObject({
            code: 'ENOENT',
        });
        expect(await readFile(join(result.archiveDirectory!, '01-Caxri', 'caxri.db'), 'utf8')).toBe(
            'fixture',
        );
        const manifestContents = await readFile(
            join(result.archiveDirectory!, 'manifest.json'),
            'utf8',
        );
        expect(JSON.parse(manifestContents)).toMatchObject({
            archiveDirectory: result.archiveDirectory,
            schemaVersion: 1,
            targets: [
                {
                    archivedPath: join(result.archiveDirectory!, '01-Caxri'),
                    originalPath: profile,
                    status: 'archived',
                },
            ],
        });
    });

    it('archives every managed development profile with its original path in the manifest', async () => {
        const { home, options, profile } = await fixture();
        await writeFile(join(profile, 'caxri.db'), 'installed', 'utf8');
        const developmentProfileRoot = join(
            home,
            'code',
            'caxri',
            '.git',
            'caxri-worktree-state',
            'profiles',
        );
        const developmentProfile = join(
            developmentProfileRoot,
            '0c96f205-681d-40c4-b54e-205cc275129d',
        );
        await mkdir(join(developmentProfile, 'logs'), { recursive: true });
        await writeFile(join(developmentProfile, 'logs', 'server-core.jsonl'), 'dev log', 'utf8');

        const result = await uninstallCaxri(
            {
                ...options,
                apply: true,
                devProfileRoot: developmentProfileRoot,
                removeGlobalCli: false,
            },
            { inspectPathOwner: () => Promise.resolve(undefined) },
        );

        expect(result.movedTargets).toEqual([profile, developmentProfile]);
        const manifest = JSON.parse(
            await readFile(join(result.archiveDirectory!, 'manifest.json'), 'utf8'),
        ) as {
            targets: Array<{ archivedPath: string; originalPath: string; status: string }>;
        };
        const archivedDevelopmentProfile = manifest.targets.find(
            (target) => target.originalPath === developmentProfile,
        );
        expect(archivedDevelopmentProfile).toMatchObject({
            originalPath: developmentProfile,
            status: 'archived',
        });
        expect(
            await readFile(
                join(archivedDevelopmentProfile!.archivedPath, 'logs', 'server-core.jsonl'),
                'utf8',
            ),
        ).toBe('dev log');
    });

    it('refuses to signal an unrelated reused PID before moving data', async () => {
        const { options, profile } = await fixture();
        await writeFile(join(profile, 'host', 'owner.lock'), JSON.stringify({ pid: 4242 }), {
            mode: 0o600,
        });
        await writeFile(join(profile, 'caxri.db'), 'fixture', 'utf8');
        const signalProcess = vi.fn();

        await expect(
            uninstallCaxri(
                { ...options, apply: true },
                {
                    inspectPathOwner: (path) =>
                        Promise.resolve(path.endsWith('owner.lock') ? 4242 : undefined),
                    inspectProcess: () => Promise.resolve('/usr/bin/node unrelated-server.js'),
                    signalProcess,
                },
            ),
        ).rejects.toThrow('not a verified Caxri Host');

        expect(signalProcess).not.toHaveBeenCalled();
        expect(await readFile(join(profile, 'caxri.db'), 'utf8')).toBe('fixture');
    });

    it('does not trust a stale manifest PID without path ownership', async () => {
        const { options, profile } = await fixture();
        await writeFile(join(profile, 'host', 'manifest.json'), JSON.stringify({ pid: 4242 }), {
            mode: 0o600,
        });
        await writeFile(join(profile, 'caxri.db'), 'fixture', 'utf8');
        const inspectProcess = vi.fn();
        const signalProcess = vi.fn();

        const result = await uninstallCaxri(
            { ...options, apply: true, removeGlobalCli: false },
            {
                inspectPathOwner: () => Promise.resolve(undefined),
                inspectProcess,
                signalProcess,
            },
        );

        expect(result.movedTargets).toEqual([profile]);
        expect(inspectProcess).not.toHaveBeenCalled();
        expect(signalProcess).not.toHaveBeenCalled();
    });

    it('does not move data when a verified Host refuses to stop', async () => {
        const { options, profile } = await fixture();
        await writeFile(join(profile, 'host', 'owner.lock'), '{}', { mode: 0o600 });
        await writeFile(join(profile, 'caxri.db'), 'fixture', 'utf8');
        const signalProcess = vi.fn();

        await expect(
            uninstallCaxri(
                { ...options, apply: true, removeGlobalCli: false },
                {
                    inspectPathOwner: (path) =>
                        Promise.resolve(path.endsWith('owner.lock') ? 4242 : undefined),
                    inspectProcess: () => Promise.resolve('/app/server/bundles/server-core.js'),
                    signalProcess,
                    waitForExit: () => Promise.resolve(false),
                },
            ),
        ).rejects.toThrow('did not stop');

        expect(signalProcess).toHaveBeenCalledWith(4242, 'SIGTERM');
        expect(await readFile(join(profile, 'caxri.db'), 'utf8')).toBe('fixture');
    });

    it('copies only the provider config relocation variables into the options', () => {
        expect(
            parseUninstallArguments(
                [],
                { CLAUDE_CONFIG_DIR: 'claude-config', CODEX_HOME: '/opt/codex', HOME: '/x' },
                '/Users/example',
                '/Users/example/code/caxri',
            ),
        ).toMatchObject({
            environmentVariables: { CLAUDE_CONFIG_DIR: 'claude-config', CODEX_HOME: '/opt/codex' },
        });
    });

    it('strips Caxri-owned Agent hooks from provider configs and keeps foreign hooks', async () => {
        const { home, options } = await fixture();
        const bridge = `'${join(home, 'Library', 'Application Support', 'caxri', 'agent-hooks', 'bin', 'caxri-agent-hook-bridge')}'`;
        // CLAUDE_CONFIG_DIR relocates the Claude config relative to the home directory.
        const claudeSettings = join(home, 'claude-config', 'settings.json');
        const codexHooks = join(home, '.codex', 'hooks.json');
        const grokHooks = join(home, '.grok', 'hooks', 'caxri.json');
        await mkdir(join(home, 'claude-config'), { recursive: true });
        await mkdir(join(home, '.codex'), { recursive: true });
        await mkdir(join(home, '.grok', 'hooks'), { recursive: true });
        await writeFile(
            claudeSettings,
            `${JSON.stringify(
                {
                    hooks: {
                        PostToolUse: [
                            {
                                matcher: '^Bash$',
                                hooks: [
                                    { type: 'command', command: 'bun ~/.claude/hooks/checks.js' },
                                    {
                                        type: 'command',
                                        command: `${bridge} --source caxri --provider claude --phase shellToolFinished --schema 99`,
                                        timeout: 5,
                                    },
                                ],
                            },
                        ],
                        Stop: [
                            {
                                hooks: [
                                    {
                                        type: 'command',
                                        command: `${bridge} --source caxri --provider claude --phase turnFinished --schema 99`,
                                    },
                                ],
                            },
                        ],
                    },
                    model: 'opus',
                },
                null,
                2,
            )}\n`,
            { mode: 0o644 },
        );
        await writeFile(
            codexHooks,
            `${JSON.stringify({
                hooks: {
                    Stop: [
                        {
                            hooks: [
                                {
                                    type: 'command',
                                    command: `${bridge} --source caxri --provider codex --phase turnFinished --schema 8`,
                                },
                            ],
                        },
                    ],
                },
            })}\n`,
            'utf8',
        );
        await writeFile(
            grokHooks,
            `${JSON.stringify({
                hooks: {
                    Stop: [
                        {
                            hooks: [
                                {
                                    type: 'command',
                                    command: `${bridge} --source caxri --provider grok --phase turnFinished --schema 2`,
                                },
                            ],
                        },
                    ],
                },
            })}\n`,
            'utf8',
        );
        const withHooks = {
            ...options,
            environmentVariables: { CLAUDE_CONFIG_DIR: 'claude-config' },
            removeGlobalCli: false,
        };

        const preview = await uninstallCaxri(withHooks, {
            inspectPathOwner: () => Promise.resolve(undefined),
        });
        expect(preview).toMatchObject({
            applied: false,
            cleanedHookConfigs: [],
            hookConfigs: [claudeSettings, codexHooks, grokHooks],
        });
        expect(JSON.parse(await readFile(claudeSettings, 'utf8'))).toHaveProperty('hooks.Stop');

        const result = await uninstallCaxri(
            { ...withHooks, apply: true },
            { inspectPathOwner: () => Promise.resolve(undefined) },
        );
        expect(result).toMatchObject({
            cleanedHookConfigs: [claudeSettings, codexHooks, grokHooks],
            failedTargets: [],
            hookConfigs: [claudeSettings, codexHooks, grokHooks],
        });
        // The newer-schema guard the running manager honours does not stop an explicit uninstall (schema 99 above).
        expect(JSON.parse(await readFile(claudeSettings, 'utf8'))).toEqual({
            hooks: {
                PostToolUse: [
                    {
                        matcher: '^Bash$',
                        hooks: [{ type: 'command', command: 'bun ~/.claude/hooks/checks.js' }],
                    },
                ],
            },
            model: 'opus',
        });
        expect((await lstat(claudeSettings)).mode & 0o777).toBe(0o644);
        expect(JSON.parse(await readFile(codexHooks, 'utf8'))).toEqual({});
        expect(JSON.parse(await readFile(grokHooks, 'utf8'))).toEqual({});
    });

    it('leaves provider configs without Caxri hooks untouched', async () => {
        const { home, options } = await fixture();
        const claudeSettings = join(home, '.claude', 'settings.json');
        await mkdir(join(home, '.claude'), { recursive: true });
        const original = `${JSON.stringify({
            hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] },
        })}\n`;
        await writeFile(claudeSettings, original, 'utf8');
        const replaceTextFile = vi.fn();

        const result = await uninstallCaxri(
            { ...options, apply: true, removeGlobalCli: false },
            { inspectPathOwner: () => Promise.resolve(undefined), replaceTextFile },
        );

        expect(result).toMatchObject({ cleanedHookConfigs: [], hookConfigs: [] });
        expect(replaceTextFile).not.toHaveBeenCalled();
        expect(await readFile(claudeSettings, 'utf8')).toBe(original);
    });

    it('reports individual move failures and continues recoverable cleanup', async () => {
        const { home, options, profile } = await fixture();
        const preferences = join(home, 'Library', 'Preferences', 'com.caxri.app.plist');
        await mkdir(join(home, 'Library', 'Preferences'), { recursive: true });
        await writeFile(preferences, 'fixture', 'utf8');

        const result = await uninstallCaxri(
            { ...options, apply: true, removeGlobalCli: false },
            {
                inspectPathOwner: () => Promise.resolve(undefined),
                moveToArchive: async (source, destination) => {
                    if (source === profile)
                        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
                    await rename(source, destination);
                },
            },
        );

        expect(result.failedTargets).toEqual([{ message: 'permission denied', path: profile }]);
        expect(result.movedTargets).toEqual([preferences]);
        expect((await lstat(profile)).isDirectory()).toBe(true);
        await expect(readFile(preferences, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        const manifestContents = await readFile(
            join(result.archiveDirectory!, 'manifest.json'),
            'utf8',
        );
        expect(JSON.parse(manifestContents)).toMatchObject({
            targets: [
                { originalPath: profile, status: 'failed' },
                { originalPath: preferences, status: 'archived' },
            ],
        });
    });
});
