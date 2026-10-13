import {
    chmod,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    stat,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import type { AgentEnvironment } from '../../../contract';
import { grantClaudeFolderTrust } from '../folder-trust';

interface ClaudeConfig {
    numStartups?: number;
    projects: Record<string, unknown>;
}

/**
 * A temporary home with an empty workspace, removed when the test finishes.
 */
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'caxri-claude-trust-'));
    onTestFinished(() => rm(root, { force: true, recursive: true }));
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    await mkdir(home, { recursive: true });
    await mkdir(workspace, { recursive: true });
    return {
        home,
        root,
        workspace,
        environment: (variables: NodeJS.ProcessEnv = {}): AgentEnvironment => ({
            homeDirectory: home,
            variables,
        }),
        readConfig: async (path = join(home, '.claude.json')): Promise<ClaudeConfig> =>
            JSON.parse(await readFile(path, 'utf8')) as ClaudeConfig,
    };
}

describe('grantClaudeFolderTrust', () => {
    it('trusts the workspace while preserving every other config value and the file mode', async () => {
        const { environment, home, readConfig, workspace } = await fixture();
        const configPath = join(home, '.claude.json');
        await writeFile(
            configPath,
            JSON.stringify({
                numStartups: 7,
                projects: {
                    '/elsewhere': { allowedTools: ['Bash'], hasTrustDialogAccepted: false },
                },
            }),
        );
        await chmod(configPath, 0o640);

        await expect(grantClaudeFolderTrust(environment(), [workspace])).resolves.toBe('granted');

        const config = await readConfig();
        expect(config.numStartups).toBe(7);
        expect(config.projects['/elsewhere']).toEqual({
            allowedTools: ['Bash'],
            hasTrustDialogAccepted: false,
        });
        expect(config.projects[workspace]).toEqual({ hasTrustDialogAccepted: true });
        expect((await stat(configPath)).mode & 0o777).toBe(0o640);
        await expect(stat(`${configPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(grantClaudeFolderTrust(environment(), [workspace])).resolves.toBe(
            'already_trusted',
        );
    });

    it('keeps the existing project entry when only its trust flag changes', async () => {
        const { environment, home, readConfig, workspace } = await fixture();
        await writeFile(
            join(home, '.claude.json'),
            JSON.stringify({ projects: { [workspace]: { lastSessionId: 'session-1' } } }),
        );

        await expect(grantClaudeFolderTrust(environment(), [workspace])).resolves.toBe('granted');

        expect((await readConfig()).projects[workspace]).toEqual({
            hasTrustDialogAccepted: true,
            lastSessionId: 'session-1',
        });
    });

    it('trusts both the symlinked and the real workspace path', async () => {
        const { environment, home, readConfig, root, workspace } = await fixture();
        const link = join(root, 'linked-workspace');
        await symlink(workspace, link);
        await writeFile(join(home, '.claude.json'), '{}');

        await expect(grantClaudeFolderTrust(environment(), [link])).resolves.toBe('granted');

        const projects = (await readConfig()).projects;
        expect(projects[link]).toEqual({ hasTrustDialogAccepted: true });
        expect(Object.values(projects)).toHaveLength(2);
    });

    it('writes beside CLAUDE_CONFIG_DIR and prefers a legacy .config.json there', async () => {
        const { environment, readConfig, root, workspace } = await fixture();
        const configDirectory = join(root, 'claude-config');
        await mkdir(configDirectory);
        await writeFile(join(configDirectory, '.claude.json'), '{}');

        await expect(
            grantClaudeFolderTrust(environment({ CLAUDE_CONFIG_DIR: configDirectory }), [
                workspace,
            ]),
        ).resolves.toBe('granted');
        expect(
            (await readConfig(join(configDirectory, '.claude.json'))).projects[workspace],
        ).toBeDefined();

        await writeFile(join(configDirectory, '.config.json'), '{}');
        await grantClaudeFolderTrust(environment({ CLAUDE_CONFIG_DIR: configDirectory }), [
            join(root, 'other'),
        ]);
        expect((await readConfig(join(configDirectory, '.config.json'))).projects).toEqual({
            [join(root, 'other')]: { hasTrustDialogAccepted: true },
        });
    });

    it('never creates a config before Claude Code has finished its first run', async () => {
        const { environment, home, workspace } = await fixture();
        await expect(grantClaudeFolderTrust(environment(), [workspace])).resolves.toBe(
            'missing_config',
        );
        await expect(stat(join(home, '.claude.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('leaves a config it cannot parse untouched', async () => {
        const { environment, home, workspace } = await fixture();
        await writeFile(join(home, '.claude.json'), '{ not json');

        await expect(grantClaudeFolderTrust(environment(), [workspace])).resolves.toBe(
            'unreadable',
        );

        expect(await readFile(join(home, '.claude.json'), 'utf8')).toBe('{ not json');
    });

    it('gives up without breaking a lock Claude Code still holds', async () => {
        const { environment, home, workspace } = await fixture();
        const configPath = join(home, '.claude.json');
        await writeFile(configPath, '{}');
        await mkdir(`${configPath}.lock`);

        await expect(
            grantClaudeFolderTrust(environment(), [workspace], {
                lockAttempts: 2,
                lockRetryDelayMs: 1,
            }),
        ).resolves.toBe('locked');

        expect(await readFile(configPath, 'utf8')).toBe('{}');
        expect((await stat(`${configPath}.lock`)).isDirectory()).toBe(true);
    });

    it('waits on the lock beside a linked config, where Claude Code takes it, and writes through the link', async () => {
        const { environment, home, readConfig, root, workspace } = await fixture();
        const configPath = join(home, '.claude.json');
        const linkedConfig = join(root, 'dotfiles.json');
        await writeFile(linkedConfig, '{}');
        await symlink(linkedConfig, configPath);
        await mkdir(`${configPath}.lock`);

        await expect(
            grantClaudeFolderTrust(environment(), [workspace], {
                lockAttempts: 1,
                lockRetryDelayMs: 1,
            }),
        ).resolves.toBe('locked');
        expect(await readFile(linkedConfig, 'utf8')).toBe('{}');

        await rm(`${configPath}.lock`, { recursive: true });
        await expect(grantClaudeFolderTrust(environment(), [workspace])).resolves.toBe('granted');
        expect((await lstat(configPath)).isSymbolicLink()).toBe(true);
        expect(Object.keys((await readConfig(linkedConfig)).projects)).not.toHaveLength(0);
    });
});
