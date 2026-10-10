import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { discoverAgentActions } from '../action-discovery';
import type { AgentActionDiscoveryAdapter } from '../contract';

const directories: string[] = [];

const claudeAdapter: AgentActionDiscoveryAdapter = {
    roots: () => [],
    commandInvocation: (name) => `/${name.replaceAll('/', ':')}`,
    skillInvocation: (name) => `/${name}`,
};

const codexAdapter: AgentActionDiscoveryAdapter = {
    roots: () => [],
    skillInvocation: (name) => `$${name}`,
};

async function temporaryDirectory(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    directories.push(directory);
    return directory;
}

afterEach(async () => {
    const pending = [...directories];
    directories.length = 0;
    await Promise.all(pending.map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('discoverAgentActions', () => {
    it('reads bounded skill frontmatter without returning paths or bodies', async () => {
        const root = await temporaryDirectory('caxri-action-skills-');
        const skillDirectory = join(root, 'commit');
        await mkdir(skillDirectory);
        await writeFile(
            join(skillDirectory, 'SKILL.md'),
            '---\nname: commit\ndescription: Commit the current changes\nargument-hint: "[message]"\n---\nPrivate instructions never cross IPC.\n',
        );

        const result = await discoverAgentActions(codexAdapter, [
            { directory: root, kind: 'skills', scope: 'project' },
        ]);

        expect(result).toEqual({
            actions: [
                {
                    invocation: '$commit',
                    kind: 'skill',
                    description: 'Commit the current changes',
                    argumentHint: '[message]',
                    requiresArguments: false,
                    source: 'project',
                },
            ],
            // Only the Server keeps where each action came from; the wire result is the actions alone.
            files: new Map([['$commit', expect.stringMatching(/commit\/SKILL\.md$/u)]]),
            partial: false,
        });
        expect(JSON.stringify(result.actions)).not.toContain(root);
        expect(JSON.stringify(result)).not.toContain('Private instructions');
    });

    it('lets a skill override a legacy command with the same Claude invocation', async () => {
        const root = await temporaryDirectory('caxri-action-claude-');
        const commandRoot = join(root, 'commands');
        const skillRoot = join(root, 'skills');
        await mkdir(join(commandRoot, 'release'), { recursive: true });
        await mkdir(join(skillRoot, 'release'), { recursive: true });
        await writeFile(
            join(commandRoot, 'release', 'deploy.md'),
            '---\ndescription: Legacy deployment command\n---\n',
        );
        await writeFile(
            join(skillRoot, 'release', 'SKILL.md'),
            '---\nname: release:deploy\ndescription: Skill deployment workflow\n---\n',
        );

        const result = await discoverAgentActions(claudeAdapter, [
            { directory: commandRoot, kind: 'commands', scope: 'legacy' },
            { directory: skillRoot, kind: 'skills', scope: 'project' },
        ]);

        expect(result.actions).toEqual([
            expect.objectContaining({
                invocation: '/release:deploy',
                kind: 'skill',
                description: 'Skill deployment workflow',
            }),
        ]);
    });

    it('refuses symlinks that escape a declared discovery root', async () => {
        const root = await temporaryDirectory('caxri-action-root-');
        const outside = await temporaryDirectory('caxri-action-outside-');
        await writeFile(
            join(outside, 'SKILL.md'),
            '---\nname: escaped\ndescription: Must not be visible\n---\n',
        );
        await symlink(outside, join(root, 'escaped'));

        const result = await discoverAgentActions(codexAdapter, [
            { directory: root, kind: 'skills', scope: 'global' },
        ]);

        expect(result).toEqual({ actions: [], files: new Map(), partial: true });
    });

    it('refuses a Project discovery root whose own symlink escapes the Project', async () => {
        const project = await temporaryDirectory('caxri-action-project-');
        const outside = await temporaryDirectory('caxri-action-outside-root-');
        const outsideSkills = join(outside, 'skills');
        await mkdir(join(outsideSkills, 'escaped'), { recursive: true });
        await writeFile(
            join(outsideSkills, 'escaped', 'SKILL.md'),
            '---\nname: escaped\ndescription: Must remain outside the Project\n---\n',
        );
        await symlink(outsideSkills, join(project, 'skills'));

        const result = await discoverAgentActions(codexAdapter, [
            {
                boundaryDirectory: project,
                directory: join(project, 'skills'),
                kind: 'skills',
                scope: 'project',
            },
        ]);

        expect(result).toEqual({ actions: [], files: new Map(), partial: true });
    });

    it('follows a skill symlink that stays inside the Project boundary but escapes the discovery root', async () => {
        const project = await temporaryDirectory('caxri-action-nested-project-');
        const nestedSkills = join(project, 'nested', '.agents', 'skills');
        await mkdir(join(nestedSkills, 'shared'), { recursive: true });
        await writeFile(
            join(nestedSkills, 'shared', 'SKILL.md'),
            '---\nname: shared\ndescription: Shared across a nested checkout\n---\n',
        );
        await mkdir(join(project, '.claude', 'skills'), { recursive: true });
        await symlink(join(nestedSkills, 'shared'), join(project, '.claude', 'skills', 'shared'));

        const result = await discoverAgentActions(claudeAdapter, [
            {
                boundaryDirectory: project,
                directory: join(project, '.claude', 'skills'),
                kind: 'skills',
                scope: 'project',
            },
        ]);

        expect(result).toEqual({
            actions: [
                {
                    invocation: '/shared',
                    kind: 'skill',
                    description: 'Shared across a nested checkout',
                    requiresArguments: false,
                    source: 'project',
                },
            ],
            files: new Map([['/shared', expect.stringMatching(/shared\/SKILL\.md$/u)]]),
            partial: false,
        });
    });

    it('reads a block scalar description and ignores nested keys', async () => {
        const root = await temporaryDirectory('caxri-action-block-');
        const skillDirectory = join(root, 'dispatch');
        await mkdir(skillDirectory);
        await writeFile(
            join(skillDirectory, 'SKILL.md'),
            '---\nname: dispatch\ndescription: |\n  Dispatch to another harness\n  through named presets.\nmetadata:\n  name: nested\n---\n',
        );

        const result = await discoverAgentActions(codexAdapter, [
            { directory: root, kind: 'skills', scope: 'project' },
        ]);

        expect(result.actions).toEqual([
            expect.objectContaining({
                invocation: '$dispatch',
                description: 'Dispatch to another harness through named presets.',
            }),
        ]);
    });

    it('ignores skills explicitly hidden from user invocation', async () => {
        const root = await temporaryDirectory('caxri-action-hidden-');
        const skillDirectory = join(root, 'internal');
        await mkdir(skillDirectory);
        await writeFile(
            join(skillDirectory, 'SKILL.md'),
            '---\nname: internal\nuser-invocable: false\n---\n',
        );

        const result = await discoverAgentActions(claudeAdapter, [
            { directory: root, kind: 'skills', scope: 'project' },
        ]);

        expect(result).toEqual({ actions: [], files: new Map(), partial: false });
    });

    it('bounds astral metadata by the wire schema length without dropping a valid skill', async () => {
        const root = await temporaryDirectory('caxri-action-unicode-');
        const skillDirectory = join(root, 'unicode');
        await mkdir(skillDirectory);
        await writeFile(
            join(skillDirectory, 'SKILL.md'),
            `---\nname: unicode\ndescription: ${'😀'.repeat(240)}\n---\n`,
        );

        const result = await discoverAgentActions(codexAdapter, [
            { directory: root, kind: 'skills', scope: 'project' },
        ]);

        expect(result.partial).toBe(false);
        expect(result.actions).toHaveLength(1);
        expect(result.actions[0]?.description?.length).toBe(240);
        expect(result.actions[0]?.description).toBe('😀'.repeat(120));
    });

    it('isolates invalid and oversized metadata while keeping valid actions', async () => {
        const root = await temporaryDirectory('caxri-action-invalid-');
        await Promise.all([
            writeFile(join(root, 'valid.md'), '---\ndescription: Valid command\n---\n'),
            writeFile(join(root, 'bad action.md'), '---\ndescription: Invalid invocation\n---\n'),
            writeFile(join(root, 'oversized.md'), 'x'.repeat(64 * 1024 + 1)),
        ]);

        const result = await discoverAgentActions(claudeAdapter, [
            { directory: root, kind: 'commands', scope: 'project' },
        ]);

        expect(result.actions).toEqual([
            expect.objectContaining({ invocation: '/valid', description: 'Valid command' }),
        ]);
        expect(result.partial).toBe(true);
    });

    it('reports partial discovery when a root exceeds the action capacity', async () => {
        const root = await temporaryDirectory('caxri-action-capacity-');
        await Promise.all(
            Array.from({ length: 257 }, (_, index) =>
                writeFile(
                    join(root, `action-${index.toString().padStart(3, '0')}.md`),
                    '---\n---\n',
                ),
            ),
        );

        const result = await discoverAgentActions(claudeAdapter, [
            { directory: root, kind: 'commands', scope: 'project' },
        ]);

        expect(result.actions).toHaveLength(256);
        expect(result.partial).toBe(true);
    });
});
