import {
    appendFile,
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as ExecutablesModule from '../../../../executables';

const mocks = vi.hoisted(() => ({
    loginPath: '/login/bin',
}));

vi.mock('../../../../executables', async (importOriginal) => {
    const actual = await importOriginal<typeof ExecutablesModule>();
    /**
     * The real implementation reads the login shell's PATH, which is whatever machine runs the suite. Stubbing it keeps
     * the assertion about what this test owns: the Agent's own variables survive, and PATH comes from the login shell
     * rather than from the caller.
     */
    const agentProcessEnvironment: typeof actual.agentProcessEnvironment = (variables = {}) =>
        Promise.resolve({ ...variables, PATH: mocks.loginPath });
    return { ...actual, agentProcessEnvironment };
});

import { clearExecutableCache } from '../../../discovery';
import { AgentService, createLocalAgentAdapters } from '../../../service';
import { claudeProvider } from '..';
import { clearClaudeMetadataCache } from '../metadata-cache';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    clearExecutableCache();
    clearClaudeMetadataCache();
    vi.unstubAllEnvs();
    const pendingCleanup = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(pendingCleanup.map((path) => rm(path, { recursive: true, force: true })));
});

describe('Claude Code provider', () => {
    it.each([
        ['CLAUDE.md', false],
        ['CLAUDE.local.md', false],
        ['CLAUDE.md', true],
        ['CLAUDE.local.md', true],
    ] as const)(
        'sends low-cost prompt through stdin and blocks %s (symlink: %s)',
        async (instructionName, isSymlink) => {
            const directory = await mkdtemp(join(tmpdir(), 'caxri-claude-low-cost-command-'));
            temporaryDirectories.push(directory);
            const executable = join(directory, 'claude.cjs');
            const argumentsPath = join(directory, 'arguments.json');
            const cwdPath = join(directory, 'cwd.txt');
            const entrypointPath = join(directory, 'entrypoint.txt');
            const exposurePath = join(directory, 'exposure.json');
            const inputPath = join(directory, 'input.txt');
            const projectDirectory = join(directory, 'project');
            const claudeHome = join(directory, 'claude-home');
            const instructionPath = join(claudeHome, instructionName);
            const instructionTarget = isSymlink
                ? join(directory, 'external-instructions.md')
                : instructionPath;
            const projectMarker = join(projectDirectory, 'private-source.txt');
            await Promise.all([mkdir(projectDirectory), mkdir(claudeHome)]);
            await Promise.all([
                writeFile(projectMarker, 'PROJECT_SOURCE_MARKER'),
                writeFile(instructionTarget, 'GLOBAL_INSTRUCTION_MARKER'),
            ]);
            if (isSymlink) await symlink(instructionTarget, instructionPath);
            await writeFile(
                executable,
                `#!${process.execPath}
const { readFileSync, writeFileSync } = require('node:fs');
writeFileSync(${JSON.stringify(argumentsPath)}, JSON.stringify(process.argv.slice(2)));
writeFileSync(${JSON.stringify(cwdPath)}, process.cwd());
writeFileSync(${JSON.stringify(entrypointPath)}, process.env.CLAUDE_CODE_ENTRYPOINT ?? '');
const readMarker = (path) => { try { return readFileSync(path, 'utf8'); } catch { return 'blocked'; } };
writeFileSync(${JSON.stringify(exposurePath)}, JSON.stringify({
    globalInstructions: readMarker(${JSON.stringify(instructionTarget)}),
    instructionEntry: readMarker(${JSON.stringify(instructionPath)}),
    projectSource: readMarker(${JSON.stringify(projectMarker)}),
}));
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
    writeFileSync(${JSON.stringify(inputPath)}, input);
    process.stdout.write('Claude Session Title');
});
`,
                'utf8',
            );
            await chmod(executable, 0o700);
            const claudeEnvironment = {
                homeDirectory: directory,
                // A Server Core started from inside another Claude session inherits its label.
                variables: { CLAUDE_CONFIG_DIR: claudeHome, CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' },
            };

            await expect(
                claudeProvider.generateTitle?.({
                    cwd: projectDirectory,
                    environment: claudeEnvironment,
                    executable,
                    prompt: 'session title fixture',
                    version: '2.1.251 (Claude Code)',
                }),
            ).resolves.toBe('Claude Session Title');
            const arguments_ = JSON.parse(await readFile(argumentsPath, 'utf8')) as string[];
            expect(arguments_).toEqual(
                expect.arrayContaining([
                    '--model',
                    'haiku',
                    '--no-session-persistence',
                    '--safe-mode',
                ]),
            );
            expect(arguments_[arguments_.indexOf('--system-prompt') + 1]).toContain(
                'Generate a concise coding-session title from the conversation below.',
            );
            expect(arguments_.join(' ')).not.toContain('session title fixture');
            expect(await readFile(inputPath, 'utf8')).toBe('session title fixture');
            expect(await readFile(cwdPath, 'utf8')).not.toBe(projectDirectory);
            expect(await readFile(entrypointPath, 'utf8')).toBe('caxri');
            /**
             * Claude Code resolves its user memory from the configuration directory, so an isolated cwd alone cannot
             * stop it. Only the host sandbox can, which is why this asserts the real subprocess rather than the built
             * argv.
             */
            const exposure = JSON.parse(await readFile(exposurePath, 'utf8')) as {
                globalInstructions: string;
                instructionEntry: string;
                projectSource: string;
            };
            expect(exposure.globalInstructions).toBe('blocked');
            expect(exposure.instructionEntry).toBe('blocked');
            expect(exposure.projectSource).toBe('blocked');
        },
    );

    it('declares skills and compatibility command roots with Claude invocation syntax', () => {
        const roots = claudeProvider.actions?.roots(
            { projectRoot: '/repo', cwd: '/repo/packages/app' },
            { homeDirectory: '/Users/dev', variables: { CLAUDE_CONFIG_DIR: '/custom/claude' } },
        );

        expect(roots?.slice(0, 4)).toEqual([
            {
                directory: '/custom/claude/commands',
                kind: 'commands',
                scope: 'global',
            },
            {
                directory: '/custom/claude/skills',
                kind: 'skills',
                scope: 'global',
            },
            {
                boundaryDirectory: '/repo',
                directory: '/repo/.claude/commands',
                kind: 'commands',
                scope: 'project',
            },
            {
                boundaryDirectory: '/repo',
                directory: '/repo/.claude/skills',
                kind: 'skills',
                scope: 'project',
            },
        ]);
        expect(roots).toEqual(
            expect.arrayContaining([
                {
                    directory: '/custom/claude/commands',
                    kind: 'commands',
                    scope: 'global',
                },
                {
                    directory: '/custom/claude/skills',
                    kind: 'skills',
                    scope: 'global',
                },
                {
                    boundaryDirectory: '/repo',
                    directory: '/repo/.claude/skills',
                    kind: 'skills',
                    scope: 'project',
                },
                {
                    boundaryDirectory: '/repo',
                    directory: '/repo/packages/app/.claude/commands',
                    kind: 'commands',
                    scope: 'project',
                },
            ]),
        );
        expect(claudeProvider.actions?.skillInvocation('deploy')).toBe('/deploy');
        expect(claudeProvider.actions?.commandInvocation?.('release/deploy')).toBe(
            '/release:deploy',
        );
    });

    it('reads Claude Code live-session metadata', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-claude-state-'));
        temporaryDirectories.push(directory);
        const root = join(directory, 'project');
        const config = join(directory, 'claude');
        const bin = join(directory, 'bin');
        await Promise.all([
            mkdir(root),
            mkdir(join(config, 'sessions'), { recursive: true }),
            mkdir(bin),
        ]);
        const executable = join(bin, 'claude');
        await writeFile(executable, '#!/bin/sh\nprintf "claude 1.0\\n"\n', 'utf8');
        await chmod(executable, 0o700);
        const metadataStartedAt = Date.now() - 1_000;
        await writeFile(
            join(config, 'sessions', 'session.json'),
            JSON.stringify({
                cwd: root,
                name: 'Repair terminal lifecycle',
                sessionId: 'claude-session-1',
                startedAt: new Date(metadataStartedAt + 1).toISOString(),
                status: 'busy',
                updatedAt: new Date(metadataStartedAt + 20).toISOString(),
            }),
            'utf8',
        );
        await writeFile(
            join(config, 'sessions', 'other-session.json'),
            JSON.stringify({
                cwd: root,
                name: 'Keep this Terminal',
                sessionId: 'claude-session-2',
                startedAt: new Date(metadataStartedAt + 2).toISOString(),
                status: 'idle',
                updatedAt: new Date(metadataStartedAt + 10).toISOString(),
            }),
            'utf8',
        );
        await writeFile(
            join(config, 'sessions', 'oversized.json'),
            `${JSON.stringify({
                cwd: root,
                name: 'Oversized metadata must be ignored',
                sessionId: 'oversized-session',
                status: 'busy',
                updatedAt: new Date().toISOString(),
            })}${' '.repeat(128 * 1024)}`,
            'utf8',
        );
        vi.stubEnv('PATH', bin);
        vi.stubEnv('SHELL', '/usr/bin/false');
        const service = new AgentService(
            undefined,
            createLocalAgentAdapters({
                homeDirectory: directory,
                variables: {
                    CLAUDE_CONFIG_DIR: config,
                    CODEX_HOME: join(directory, 'missing-codex'),
                },
            }),
        );

        await expect(
            service.snapshot('claude', { rootPath: root, processState: 'running' }),
        ).resolves.toMatchObject({
            attentionKind: undefined,
            available: true,
            sessionId: 'claude-session-1',
            status: 'running',
            title: 'Repair terminal lifecycle',
            version: 'claude 1.0',
        });
        await expect(
            service.snapshot('claude', {
                excludedAgentSessionIds: ['claude-session-1'],
                rootPath: root,
                processState: 'running',
            }),
        ).resolves.toMatchObject({
            // Claude Code's `idle` only means no turn is running, never that it is blocked on the user.
            attentionKind: 'completed',
            sessionId: 'claude-session-2',
            status: 'completed',
            title: 'Keep this Terminal',
        });
        await expect(
            service.snapshot('claude', {
                agentSessionId: 'claude-session-1',
                rootPath: root,
                processState: 'running',
                startedAt: Date.now(),
            }),
        ).resolves.toMatchObject({
            attentionKind: undefined,
            sessionId: 'claude-session-1',
            status: 'unknown',
            title: 'Repair terminal lifecycle',
        });
    });

    it('prefers the transcript AI title over a directory-derived live-session name', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-claude-title-'));
        temporaryDirectories.push(directory);
        const root = join(directory, 'project');
        const config = join(directory, 'claude');
        const bin = join(directory, 'bin');
        const projectDirectory = join(config, 'projects', root.replaceAll(/[^a-z0-9]/gi, '-'));
        await Promise.all([
            mkdir(root),
            mkdir(join(config, 'sessions'), { recursive: true }),
            mkdir(projectDirectory, { recursive: true }),
            mkdir(bin),
        ]);
        const executable = join(bin, 'claude');
        await writeFile(executable, '#!/bin/sh\nprintf "claude 1.0\\n"\n', 'utf8');
        await chmod(executable, 0o700);
        await writeFile(
            join(config, 'sessions', 'session.json'),
            JSON.stringify({
                cwd: root,
                name: 'project-worktree-7d',
                nameSource: 'derived',
                sessionId: 'claude-session-derived',
                status: 'busy',
                updatedAt: new Date().toISOString(),
            }),
            'utf8',
        );
        const transcript = join(projectDirectory, 'claude-session-derived.jsonl');
        await writeFile(
            transcript,
            `${JSON.stringify({ sessionId: 'claude-session-derived', type: 'user' })}\n${JSON.stringify(
                {
                    aiTitle: 'Migrate market search to Elasticsearch',
                    sessionId: 'claude-session-derived',
                    type: 'ai-title',
                },
            )}\n`,
            'utf8',
        );
        vi.stubEnv('PATH', bin);
        vi.stubEnv('SHELL', '/usr/bin/false');
        const service = new AgentService(
            undefined,
            createLocalAgentAdapters({
                homeDirectory: directory,
                variables: {
                    CLAUDE_CONFIG_DIR: config,
                    CODEX_HOME: join(directory, 'missing-codex'),
                },
            }),
        );

        await expect(
            service.snapshot('claude', { rootPath: root, processState: 'running' }),
        ).resolves.toMatchObject({ title: 'Migrate market search to Elasticsearch' });

        // A later ai-title append must win on the next incremental poll.
        await appendFile(
            transcript,
            `${JSON.stringify({
                aiTitle: 'Migrate market search to ES with flags',
                sessionId: 'claude-session-derived',
                type: 'ai-title',
            })}\n`,
            'utf8',
        );
        await expect(
            service.snapshot('claude', { rootPath: root, processState: 'running' }),
        ).resolves.toMatchObject({ title: 'Migrate market search to ES with flags' });

        // A `/rename` (interactive or Caxri's own non-interactive manual rename) appends `custom-title`, which
        // the live metadata never reflects; it must win over the earlier ai-title.
        await appendFile(
            transcript,
            `${JSON.stringify({
                customTitle: 'Qwen3.8-Max-0902 Description',
                sessionId: 'claude-session-derived',
                type: 'custom-title',
            })}\n${JSON.stringify({
                agentName: 'Qwen3.8-Max-0902 Description',
                sessionId: 'claude-session-derived',
                type: 'agent-name',
            })}\n`,
            'utf8',
        );
        await expect(
            service.snapshot('claude', { rootPath: root, processState: 'running' }),
        ).resolves.toMatchObject({ title: 'Qwen3.8-Max-0902 Description' });

        // Claude Code re-appends its own `ai-title` after later turns. Like Claude Code itself
        // (`customTitle || aiTitle`), the explicit rename keeps precedence regardless of append order.
        await appendFile(
            transcript,
            `${JSON.stringify({
                aiTitle: 'Regenerated after rename',
                sessionId: 'claude-session-derived',
                type: 'ai-title',
            })}\n`,
            'utf8',
        );
        await expect(
            service.snapshot('claude', { rootPath: root, processState: 'running' }),
        ).resolves.toMatchObject({ title: 'Qwen3.8-Max-0902 Description' });

        await writeFile(
            join(config, 'projects', 'outside.jsonl'),
            `${JSON.stringify({ aiTitle: 'Escaped title', type: 'ai-title' })}\n`,
            'utf8',
        );
        const escapedMetadataUpdatedAt = new Date(Date.now() + 1_000).toISOString();
        await writeFile(
            join(config, 'sessions', 'session.json'),
            JSON.stringify({
                cwd: root,
                name: 'project-worktree-7d',
                nameSource: 'derived',
                sessionId: '../../outside',
                status: 'busy',
                updatedAt: escapedMetadataUpdatedAt,
            }),
            'utf8',
        );
        // Without a readable transcript title, the directory-derived placeholder must not surface as a title:
        // persisting it would overwrite the name the last rename already wrote.
        const escaped = await service.snapshot('claude', {
            rootPath: root,
            processState: 'running',
        });
        expect(escaped.title).toBeUndefined();
    });

    it('never exposes a raw transcript prompt as the Session title', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-claude-last-prompt-'));
        temporaryDirectories.push(directory);
        const root = join(directory, 'project');
        const config = join(directory, 'claude');
        const bin = join(directory, 'bin');
        const projectDirectory = join(config, 'projects', root.replaceAll(/[^a-z0-9]/gi, '-'));
        await Promise.all([
            mkdir(root),
            mkdir(join(config, 'sessions'), { recursive: true }),
            mkdir(projectDirectory, { recursive: true }),
            mkdir(bin),
        ]);
        const executable = join(bin, 'claude');
        await writeFile(executable, '#!/bin/sh\nprintf "claude 1.0\\n"\n', 'utf8');
        await chmod(executable, 0o700);
        await writeFile(
            join(config, 'sessions', 'session.json'),
            JSON.stringify({
                cwd: root,
                name: 'project-derived-77',
                nameSource: 'derived',
                sessionId: 'claude-session-prompted',
                status: 'busy',
                updatedAt: new Date().toISOString(),
            }),
            'utf8',
        );
        const transcript = join(projectDirectory, 'claude-session-prompted.jsonl');
        await writeFile(
            transcript,
            `${JSON.stringify({
                message: { content: 'hello', role: 'user' },
                sessionId: 'claude-session-prompted',
                type: 'user',
            })}\n${JSON.stringify({
                lastPrompt: 'hello',
                sessionId: 'claude-session-prompted',
                type: 'last-prompt',
            })}\n`,
            'utf8',
        );
        vi.stubEnv('PATH', bin);
        vi.stubEnv('SHELL', '/usr/bin/false');
        const service = new AgentService(
            undefined,
            createLocalAgentAdapters({
                homeDirectory: directory,
                variables: {
                    CLAUDE_CONFIG_DIR: config,
                    CODEX_HOME: join(directory, 'missing-codex'),
                },
            }),
        );

        const initial = await service.snapshot('claude', {
            rootPath: root,
            processState: 'running',
        });
        expect(initial.title).toBeUndefined();

        // Later prompt records also stay private.
        await appendFile(
            transcript,
            `${JSON.stringify({
                lastPrompt: `  \n  next question about lifecycles  \nsecond line ignored`,
                sessionId: 'claude-session-prompted',
                type: 'last-prompt',
            })}\n`,
            'utf8',
        );
        const prompted = await service.snapshot('claude', {
            rootPath: root,
            processState: 'running',
        });
        expect(prompted.title).toBeUndefined();

        // A provider-generated title remains safe to surface.
        await appendFile(
            transcript,
            `${JSON.stringify({
                aiTitle: 'Repair terminal lifecycles',
                sessionId: 'claude-session-prompted',
                type: 'ai-title',
            })}\n`,
            'utf8',
        );
        await expect(
            service.snapshot('claude', { rootPath: root, processState: 'running' }),
        ).resolves.toMatchObject({ title: 'Repair terminal lifecycles' });
    });

    it('keeps an explicitly named session title and never surfaces a derived name without a transcript title', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-claude-title-fallback-'));
        temporaryDirectories.push(directory);
        const root = join(directory, 'project');
        const config = join(directory, 'claude');
        const bin = join(directory, 'bin');
        const projectDirectory = join(config, 'projects', root.replaceAll(/[^a-z0-9]/gi, '-'));
        await Promise.all([
            mkdir(root),
            mkdir(join(config, 'sessions'), { recursive: true }),
            mkdir(projectDirectory, { recursive: true }),
            mkdir(bin),
        ]);
        const executable = join(bin, 'claude');
        await writeFile(executable, '#!/bin/sh\nprintf "claude 1.0\\n"\n', 'utf8');
        await chmod(executable, 0o700);
        await writeFile(
            join(config, 'sessions', 'named.json'),
            JSON.stringify({
                cwd: root,
                name: 'My renamed session',
                nameSource: 'user',
                sessionId: 'claude-session-named',
                status: 'busy',
                updatedAt: new Date().toISOString(),
            }),
            'utf8',
        );
        await writeFile(
            join(projectDirectory, 'claude-session-named.jsonl'),
            `${JSON.stringify({
                aiTitle: 'Should not override explicit names',
                sessionId: 'claude-session-named',
                type: 'ai-title',
            })}\n`,
            'utf8',
        );
        vi.stubEnv('PATH', bin);
        vi.stubEnv('SHELL', '/usr/bin/false');
        const service = new AgentService(
            undefined,
            createLocalAgentAdapters({
                homeDirectory: directory,
                variables: {
                    CLAUDE_CONFIG_DIR: config,
                    CODEX_HOME: join(directory, 'missing-codex'),
                },
            }),
        );

        await expect(
            service.snapshot('claude', { rootPath: root, processState: 'running' }),
        ).resolves.toMatchObject({ title: 'My renamed session' });

        // A derived placeholder name without any transcript title must not surface: persisting it would overwrite
        // the title the last rename already wrote.
        await writeFile(
            join(config, 'sessions', 'named.json'),
            JSON.stringify({
                cwd: root,
                name: 'project-derived-name',
                nameSource: 'derived',
                sessionId: 'claude-session-transcriptless',
                status: 'busy',
                updatedAt: new Date().toISOString(),
            }),
            'utf8',
        );
        const transcriptless = await service.snapshot('claude', {
            rootPath: root,
            processState: 'running',
        });
        expect(transcriptless).toMatchObject({ sessionId: 'claude-session-transcriptless' });
        expect(transcriptless.title).toBeUndefined();
    });
});
