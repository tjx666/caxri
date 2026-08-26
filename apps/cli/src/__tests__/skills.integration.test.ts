import {
    lstat,
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    readlink,
    realpath,
    rename,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SKILL_BUNDLE_VERSION } from '@caxri/agent-skills';
import {
    CAXRI_SKILL_FILES,
    inspectManagedSkill,
    installManagedSkill,
    prepareSkillParent,
    updateManagedSkill,
    withSkillMutationLock,
} from '@caxri/agent-skills/testing';
import { agentMessagePullResultSchema } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CliIo } from '../application';
import { runCli } from '../application';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const directories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(
        directories.map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

async function readdirOrEmpty(directory: string): Promise<string[]> {
    try {
        return await readdir(directory);
    } catch {
        return [];
    }
}

async function isolatedDirectory(name: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), `caxri-skill-${name}-`));
    temporaryDirectories.push(directory);
    return directory;
}

function output(): { io: CliIo; stderr(): string; stdout(): string } {
    let stdout = '';
    let stderr = '';
    return {
        io: {
            stderrIsTTY: false,
            stdinIsTTY: false,
            stdoutIsTTY: false,
            writeStderr: (value) => {
                stderr += value;
            },
            writeStdout: (value) => {
                stdout += value;
            },
        },
        stderr: () => stderr,
        stdout: () => stdout,
    };
}

async function invoke(
    argv: readonly string[],
    context: { cwd: string; environment?: NodeJS.ProcessEnv; home: string },
) {
    const value = output();
    const connect = vi.fn();
    const code = await runCli(argv, {
        connect,
        cwd: context.cwd,
        environment: { HOME: context.home, ...context.environment },
        home: context.home,
        io: value.io,
    });
    return { code, connect, stderr: value.stderr(), stdout: value.stdout() };
}

describe('bundled Caxri Agent skill', () => {
    it('lists and reads version-matched metadata offline without exposing paths or credentials', async () => {
        const root = await isolatedDirectory('offline');
        const token = 'ab'.repeat(32);
        const context = {
            cwd: root,
            home: join(root, 'home'),
            environment: {
                CAXRI_AGENT_ENDPOINT_GENERATION: '2',
                CAXRI_AGENT_ENDPOINT_HOST_ID: 'a'.repeat(32),
                CAXRI_AGENT_ENDPOINT_ID: 'endpoint-1',
                CAXRI_AGENT_ENDPOINT_TOKEN: token,
                CAXRI_USER_DATA_DIR: join(root, 'profile'),
            },
        };

        const listed = await invoke(['skills', 'list', '--json'], context);
        const metadata = JSON.parse(listed.stdout) as {
            skills: Array<{
                bundledVersion: string;
                contentHash: string;
                protocolVersion?: number;
            }>;
        };
        expect(listed.code).toBe(0);
        expect(metadata.skills).toHaveLength(1);
        expect(metadata.skills[0]).toMatchObject({ bundledVersion: SKILL_BUNDLE_VERSION });
        expect(metadata.skills[0]?.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
        expect(listed.connect).not.toHaveBeenCalled();

        const full = await invoke(['skills', 'get', 'caxri-cli', '--full', '--json'], context);
        const fullValue = JSON.parse(full.stdout) as {
            bundledVersion: string;
            content: string;
            name: string;
        };
        expect(full.code).toBe(0);
        expect(fullValue.bundledVersion).toBe(SKILL_BUNDLE_VERSION);
        expect(fullValue.content).toContain('caxri agent-context --json');
        expect(fullValue.name).toBe('caxri-cli');
        expect(`${listed.stdout}${full.stdout}${listed.stderr}${full.stderr}`).not.toContain(root);
        expect(`${listed.stdout}${full.stdout}${listed.stderr}${full.stderr}`).not.toContain(token);
        expect(full.connect).not.toHaveBeenCalled();
    });

    it('installs idempotently, updates an intact older marker, and preserves foreign entries', async () => {
        const root = await isolatedDirectory('local');
        const home = join(root, 'home');
        const skillsRoot = join(root, '.agents', 'skills');
        const target = join(skillsRoot, 'caxri-cli');
        const foreign = join(skillsRoot, 'foreign-skill');
        await mkdir(foreign, { recursive: true });
        await writeFile(join(foreign, 'SKILL.md'), 'foreign content\n', 'utf8');
        const context = { cwd: root, home };

        const installed = await invoke(
            ['skills', 'install', 'caxri-cli', '--provider', 'codex', '--local', '--yes', '--json'],
            context,
        );
        expect(installed.code).toBe(0);
        expect(JSON.parse(installed.stdout)).toMatchObject({
            changed: true,
            operation: 'install',
            skill: { status: 'compatible' },
        });
        expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toBe(
            CAXRI_SKILL_FILES['SKILL.md'],
        );
        const targetIdentity = await lstat(target, { bigint: true });
        const initialRelease = await readlink(target);
        expect(targetIdentity.isSymbolicLink()).toBe(true);
        expect((await lstat(join(target, 'SKILL.md'))).isFile()).toBe(true);

        const repeated = await invoke(
            ['skills', 'install', 'caxri-cli', '--provider', 'codex', '--local', '--yes', '--json'],
            context,
        );
        expect(JSON.parse(repeated.stdout)).toMatchObject({ changed: false });

        const markerPath = join(target, '.caxri-skill.json');
        const marker = JSON.parse(await readFile(markerPath, 'utf8')) as Record<string, unknown>;
        marker.installedVersion = '0.0.5';
        await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
        const stale = await invoke(
            ['skills', 'status', '--provider', 'codex', '--local', '--json'],
            context,
        );
        const staleValue = JSON.parse(stale.stdout) as {
            installations: Array<{
                installedVersion: string;
                reason: string;
                repairCommand: string;
                status: string;
            }>;
        };
        expect(staleValue.installations[0]).toMatchObject({
            installedVersion: '0.0.5',
            reason: 'older-version',
            status: 'stale',
        });
        expect(staleValue.installations[0]?.repairCommand).toContain('skills update');

        const updated = await invoke(
            ['skills', 'update', 'caxri-cli', '--provider', 'codex', '--local', '--yes', '--json'],
            context,
        );
        expect(JSON.parse(updated.stdout)).toMatchObject({
            changed: true,
            skill: { installedVersion: SKILL_BUNDLE_VERSION, status: 'compatible' },
        });
        expect((await lstat(target, { bigint: true })).ino).not.toBe(targetIdentity.ino);
        expect(await readlink(target)).not.toBe(initialRelease);
        expect(await readFile(join(foreign, 'SKILL.md'), 'utf8')).toBe('foreign content\n');
        expect((await readdir(skillsRoot)).some((name) => name.includes('stage'))).toBe(false);
        expect((await readdir(skillsRoot)).some((name) => name.includes('backup'))).toBe(false);

        const removed = await invoke(
            [
                'skills',
                'uninstall',
                'caxri-cli',
                '--provider',
                'codex',
                '--local',
                '--yes',
                '--json',
            ],
            context,
        );
        expect(JSON.parse(removed.stdout)).toMatchObject({
            changed: true,
            skill: { status: 'missing' },
        });
        expect(await readdir(skillsRoot)).toEqual(['foreign-skill']);
    });

    it('keeps the active release intact when atomic activation fails', async () => {
        const root = await isolatedDirectory('activation-failure');
        const context = { cwd: root, home: join(root, 'home') };
        const installed = await invoke(
            ['skills', 'install', 'caxri-cli', '--provider', 'codex', '--local', '--yes', '--json'],
            context,
        );
        expect(installed.code).toBe(0);
        const target = join(root, '.agents', 'skills', 'caxri-cli');
        const beforeRelease = await readlink(target);
        const beforeContent = await readFile(join(target, 'SKILL.md'), 'utf8');
        const inspection = await inspectManagedSkill(target, {
            files: CAXRI_SKILL_FILES,
            name: 'caxri-cli',
        });
        expect(inspection.kind).toBe('managed');
        if (inspection.kind !== 'managed') throw new Error('Expected a managed skill fixture');

        await expect(
            updateManagedSkill(
                inspection.layout,
                {
                    files: CAXRI_SKILL_FILES,
                    marker: inspection.layout.markerSource,
                    name: 'caxri-cli',
                },
                () => Promise.reject(new Error('injected activation failure')),
            ),
        ).rejects.toThrow('injected activation failure');
        expect(await readlink(target)).toBe(beforeRelease);
        expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toBe(beforeContent);
        expect(
            (await readdir(join(root, '.agents', 'skills'))).some((name) =>
                name.startsWith('caxri-cli.caxri-next-'),
            ),
        ).toBe(false);
        expect(
            await readdir(join(root, '.agents', 'skills', '.caxri-caxri-cli', 'releases')),
        ).toHaveLength(1);
    });

    it('serializes concurrent installs and recovers a stale operation lock', async () => {
        const root = await isolatedDirectory('locking');
        const context = { cwd: root, home: join(root, 'home') };
        const argv = [
            'skills',
            'install',
            'caxri-cli',
            '--provider',
            'codex',
            '--local',
            '--yes',
            '--json',
        ] as const;
        const [first, second] = await Promise.all([invoke(argv, context), invoke(argv, context)]);
        expect([first.code, second.code]).toEqual([0, 0]);
        const changes = [first, second]
            .map((result) => (JSON.parse(result.stdout) as { changed: boolean }).changed)
            .toSorted((left, right) => Number(left) - Number(right));
        expect(changes).toEqual([false, true]);

        const removed = await invoke(
            [
                'skills',
                'uninstall',
                'caxri-cli',
                '--provider',
                'codex',
                '--local',
                '--yes',
                '--json',
            ],
            context,
        );
        expect(removed.code).toBe(0);
        const skillsRoot = join(root, '.agents', 'skills');
        const lock = join(skillsRoot, '.caxri-cli.lock');
        await symlink('caxri-lock-v1-2147483647-1-00000000-0000-4000-8000-000000000000', lock);
        const recovered = await invoke(argv, context);
        expect(recovered.code).toBe(0);
        expect(JSON.parse(recovered.stdout)).toMatchObject({ changed: true });
        await expect(readlink(lock)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('does not replace a foreign target inserted at the final install boundary', async () => {
        const root = await isolatedDirectory('foreign-race');
        const parent = join(root, '.agents', 'skills');
        const target = join(parent, 'caxri-cli');
        await mkdir(parent, { recursive: true });
        const marker = JSON.stringify({
            files: Object.keys(CAXRI_SKILL_FILES),
            managedBy: 'caxri',
        });
        await expect(
            installManagedSkill(
                target,
                { files: CAXRI_SKILL_FILES, marker, name: 'caxri-cli' },
                async () => {
                    await mkdir(target);
                    await writeFile(join(target, 'SKILL.md'), 'foreign-race-content\n', 'utf8');
                },
            ),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toBe('foreign-race-content\n');
    });

    it('anchors writes to the verified parent when its lexical path is replaced', async () => {
        const root = await isolatedDirectory('parent-race');
        const outside = await isolatedDirectory('parent-race-outside');
        const physicalRoot = await realpath(root);
        const parent = join(physicalRoot, '.agents', 'skills');
        const movedParent = join(physicalRoot, 'detached-skills');
        const target = join(parent, 'caxri-cli');
        const location = await prepareSkillParent(target, physicalRoot);
        const marker = JSON.stringify({
            files: Object.keys(CAXRI_SKILL_FILES),
            managedBy: 'caxri',
        });

        await expect(
            withSkillMutationLock(location, async (anchoredTarget) => {
                await rename(parent, movedParent);
                await symlink(outside, parent, 'dir');
                await installManagedSkill(anchoredTarget, {
                    files: CAXRI_SKILL_FILES,
                    marker,
                    name: 'caxri-cli',
                });
            }),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(await readdir(outside)).toEqual([]);
        expect(await readFile(join(movedParent, 'caxri-cli', 'SKILL.md'), 'utf8')).toBe(
            CAXRI_SKILL_FILES['SKILL.md'],
        );
    });

    it('rejects a project-owned Provider parent symlink without writing outside the Project', async () => {
        const root = await isolatedDirectory('parent-symlink');
        const outside = await isolatedDirectory('outside');
        await symlink(outside, join(root, '.agents'), 'dir');
        const result = await invoke(
            ['skills', 'install', 'caxri-cli', '--provider', 'codex', '--local', '--yes', '--json'],
            { cwd: root, home: join(root, 'home') },
        );
        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain('unsafe symbolic link');
        expect(await readdir(outside)).toEqual([]);
    });

    it('requires explicit Provider and scope and preserves unmarked local skills', async () => {
        const root = await isolatedDirectory('foreign');
        const context = { cwd: root, home: join(root, 'home') };
        const target = join(root, '.claude', 'skills', 'caxri-cli');
        await mkdir(target, { recursive: true });
        await writeFile(join(target, 'SKILL.md'), 'user-owned\n', 'utf8');

        const noScope = await invoke(
            ['skills', 'install', 'caxri-cli', '--provider', 'codex', '--yes', '--json'],
            context,
        );
        expect(noScope.code).not.toBe(0);
        expect(noScope.stderr).toContain('requires --local or --global');

        const unmarked = await invoke(
            [
                'skills',
                'install',
                'caxri-cli',
                '--provider',
                'claude',
                '--local',
                '--yes',
                '--json',
            ],
            context,
        );
        expect(unmarked.code).not.toBe(0);
        expect(unmarked.stderr).toContain('unmarked skill');
        expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toBe('user-owned\n');
    });

    it('writes global installs only to explicit isolated Codex and Claude configuration roots', async () => {
        const root = await isolatedDirectory('providers');
        const codexHome = join(root, 'codex-config');
        const claudeConfig = join(root, 'claude-config');
        const home = join(root, 'home');
        const context = {
            cwd: join(root, 'project'),
            home,
            environment: { CLAUDE_CONFIG_DIR: claudeConfig, CODEX_HOME: codexHome },
        };
        await mkdir(context.cwd, { recursive: true });

        for (const [provider, target] of [
            ['codex', join(codexHome, 'skills', 'caxri-cli')],
            ['claude', join(claudeConfig, 'skills', 'caxri-cli')],
        ] as const) {
            // Each provider iteration installs then uninstalls against the same shared `home`
            // fixture; iterations must run sequentially to observe a clean state transition per
            // provider, not concurrently.
            // eslint-disable-next-line no-await-in-loop
            const installed = await invoke(
                [
                    'skills',
                    'install',
                    'caxri-cli',
                    '--provider',
                    provider,
                    '--global',
                    '--yes',
                    '--json',
                ],
                context,
            );
            expect(JSON.parse(installed.stdout)).toMatchObject({
                changed: true,
                skill: { provider, scope: 'global', status: 'compatible' },
            });
            // eslint-disable-next-line no-await-in-loop -- see the install-call justification above.
            expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toBe(
                CAXRI_SKILL_FILES['SKILL.md'],
            );
            expect(installed.stdout).not.toContain(root);

            // eslint-disable-next-line no-await-in-loop -- see the install-call justification above.
            const removed = await invoke(
                [
                    'skills',
                    'uninstall',
                    'caxri-cli',
                    '--provider',
                    provider,
                    '--global',
                    '--yes',
                    '--json',
                ],
                context,
            );
            expect(JSON.parse(removed.stdout)).toMatchObject({
                changed: true,
                skill: { provider, scope: 'global', status: 'missing' },
            });
        }
        expect(await readdirOrEmpty(home)).toEqual([]);
    });

    it('fails closed on a future global marker schema and reports actionable path-free health', async () => {
        const root = await isolatedDirectory('future');
        const codexHome = join(root, 'isolated-codex');
        const context = {
            cwd: join(root, 'project'),
            home: join(root, 'home'),
            environment: { CODEX_HOME: codexHome },
        };
        await mkdir(context.cwd, { recursive: true });

        const installed = await invoke(
            [
                'skills',
                'install',
                'caxri-cli',
                '--provider',
                'codex',
                '--global',
                '--yes',
                '--json',
            ],
            context,
        );
        expect(installed.code).toBe(0);
        const target = join(codexHome, 'skills', 'caxri-cli');
        const markerPath = join(target, '.caxri-skill.json');
        const marker = JSON.parse(await readFile(markerPath, 'utf8')) as Record<string, unknown>;
        marker.schemaVersion = 99;
        marker.installedVersion = '99.0.0';
        await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');

        const status = await invoke(
            ['skills', 'status', '--provider', 'codex', '--global', '--json'],
            context,
        );
        const statusValue = JSON.parse(status.stdout) as {
            installations: Array<{
                action: string;
                installedSchemaVersion: number;
                installedVersion: string;
                reason: string;
                status: string;
            }>;
        };
        expect(statusValue.installations[0]).toMatchObject({
            installedSchemaVersion: 99,
            installedVersion: '99.0.0',
            reason: 'unknown-schema',
            status: 'conflict',
        });
        expect(statusValue.installations[0]?.action).toContain('schema 99');
        expect(status.stdout).not.toContain(root);

        const update = await invoke(
            ['skills', 'update', 'caxri-cli', '--provider', 'codex', '--global', '--yes', '--json'],
            context,
        );
        expect(update.code).not.toBe(0);
        expect(update.stderr).toContain('schema 99');
        expect(JSON.parse(await readFile(markerPath, 'utf8'))).toMatchObject({ schemaVersion: 99 });
    });

    it('refuses to downgrade an intact skill from a newer Caxri CLI version', async () => {
        const root = await isolatedDirectory('newer');
        const context = { cwd: root, home: join(root, 'home') };
        const install = await invoke(
            ['skills', 'install', 'caxri-cli', '--provider', 'codex', '--local', '--yes', '--json'],
            context,
        );
        expect(install.code).toBe(0);
        const markerPath = join(root, '.agents', 'skills', 'caxri-cli', '.caxri-skill.json');
        const marker = JSON.parse(await readFile(markerPath, 'utf8')) as Record<string, unknown>;
        marker.installedVersion = '99.0.0';
        await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');

        const update = await invoke(
            ['skills', 'update', 'caxri-cli', '--provider', 'codex', '--local', '--yes', '--json'],
            context,
        );
        expect(update.code).not.toBe(0);
        expect(update.stderr).toContain('99.0.0 or newer');
        expect(JSON.parse(await readFile(markerPath, 'utf8'))).toMatchObject({
            installedVersion: '99.0.0',
        });
    });

    it('keeps canonical files and documented JSON examples schema-valid', async () => {
        const canonicalSkill = await readFile(
            new URL('../../../../skills/caxri-cli/SKILL.md', import.meta.url),
            'utf8',
        );
        const canonicalMetadata = await readFile(
            new URL('../../../../skills/caxri-cli/agents/openai.yaml', import.meta.url),
            'utf8',
        );
        expect(CAXRI_SKILL_FILES).toEqual({
            'SKILL.md': canonicalSkill,
            'agents/openai.yaml': canonicalMetadata,
        });

        const examples = canonicalSkill
            .matchAll(/```json\n([^`]+)\n```/gu)
            .map((match) => JSON.parse(match[1]) as unknown)
            .toArray();
        expect(examples).toHaveLength(1);
        expect(agentMessagePullResultSchema.parse(examples[0])).toEqual({
            message: null,
            outcome: 'empty',
        });
    });
});
