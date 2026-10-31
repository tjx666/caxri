import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { executeSkillCommand } from '@caxri/agent-skills';
import { agentSkillHealthSchema } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestDomainServices } from '../../__tests__/support/domain-services';
import { createFakePty } from './create-test-domain-services';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

describe('Runtime Agent skill health', () => {
    it('shares the offline CLI projection without guessing a local root or exposing paths', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-runtime-agent-skills-'));
        temporaryDirectories.push(directory);
        const userDataPath = join(directory, 'user-data');
        const projectRoot = join(directory, 'project');
        const home = join(directory, 'home');
        const environment = {
            CLAUDE_CONFIG_DIR: join(directory, 'claude'),
            CODEX_HOME: join(directory, 'codex'),
            GROK_HOME: join(directory, 'grok'),
        };
        await Promise.all([
            mkdir(projectRoot),
            mkdir(home),
            mkdir(environment.CLAUDE_CONFIG_DIR),
            mkdir(environment.CODEX_HOME),
            mkdir(environment.GROK_HOME),
        ]);
        const runtime = await createTestDomainServices({
            agentEnvironment: { homeDirectory: home, variables: environment },
            logger: new StructuredLogger(join(directory, 'logs')),
            send: () => {},
            terminal: {
                spawn: vi.fn(() => createFakePty()),
            },
            userDataPath,
        });

        try {
            const withoutProject = await runtime.handlers['agentSkills.get']({});
            expect(withoutProject).toMatchObject({
                installations: ['claude', 'codex', 'grok', 'antigravity'].map((provider) => ({
                    provider,
                    scope: 'global',
                    status: 'missing',
                })),
            });
            expect(withoutProject.installations.some(({ scope }) => scope === 'local')).toBe(false);

            const project = await runtime.handlers['project.create']({ rootPath: projectRoot });
            const session = await runtime.handlers['session.create']({
                defaultAgent: 'shell',
                projectId: project.id,
            });
            await executeSkillCommand(
                'install',
                { name: 'caxri-cli', provider: 'codex', scope: 'local' },
                { cwd: projectRoot, environment, home },
            );
            await executeSkillCommand(
                'install',
                { name: 'caxri-cli', provider: 'antigravity', scope: 'global' },
                { cwd: projectRoot, environment, home },
            );
            // Antigravity reads `~/.gemini/config/skills` and reads no variable that relocates it.
            await expect(
                readdir(join(home, '.gemini', 'config', 'skills', 'caxri-cli')),
            ).resolves.toContain('SKILL.md');
            await runtime.handlers['session.archive']({ sessionId: session.session.id });

            const health = await runtime.handlers['agentSkills.get']({});
            expect(agentSkillHealthSchema.parse(health)).toEqual(health);
            expect(health.selectedProjectId).toBe(project.id);
            expect(health.installations).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        compatible: true,
                        installedVersion: health.bundled.bundledVersion,
                        provider: 'codex',
                        scope: 'local',
                        status: 'compatible',
                    }),
                    expect.objectContaining({
                        provider: 'codex',
                        scope: 'global',
                        status: 'missing',
                    }),
                    // Codex and Antigravity share the Project's `.agents/skills` folder.
                    expect.objectContaining({
                        provider: 'antigravity',
                        scope: 'local',
                        status: 'compatible',
                    }),
                    expect.objectContaining({
                        provider: 'antigravity',
                        scope: 'global',
                        status: 'compatible',
                    }),
                ]),
            );
            const serialized = JSON.stringify(health);
            expect(serialized).not.toContain(directory);
            expect(serialized).not.toContain('.caxri-skill.json');
            expect(serialized).not.toContain('SKILL.md\n');
        } finally {
            await runtime.close();
        }
    });
});
