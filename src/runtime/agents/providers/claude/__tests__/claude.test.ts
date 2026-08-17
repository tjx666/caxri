import { appendFile, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearExecutableCache } from '../../../discovery';
import { AgentService, createLocalAgentAdapters } from '../../../service';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    clearExecutableCache();
    vi.unstubAllEnvs();
    const pendingCleanup = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(pendingCleanup.map((path) => rm(path, { recursive: true, force: true })));
});

describe('Claude Code provider', () => {
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
            attentionKind: 'waiting',
            sessionId: 'claude-session-2',
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
            status: 'running',
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
    });

    it('falls back to the transcript last prompt before the derived name, mirroring the /resume list', async () => {
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

        await expect(
            service.snapshot('claude', { rootPath: root, processState: 'running' }),
        ).resolves.toMatchObject({ title: 'hello' });

        // A newer prompt replaces the fallback label on the next incremental poll.
        await appendFile(
            transcript,
            `${JSON.stringify({
                lastPrompt: `  \n  next question about lifecycles  \nsecond line ignored`,
                sessionId: 'claude-session-prompted',
                type: 'last-prompt',
            })}\n`,
            'utf8',
        );
        await expect(
            service.snapshot('claude', { rootPath: root, processState: 'running' }),
        ).resolves.toMatchObject({ title: 'next question about lifecycles' });

        // An AI-generated title always outranks the prompt fallback.
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

    it('keeps an explicitly named session title and falls back to the derived name without a transcript', async () => {
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

        // Derived name without any transcript still surfaces as the fallback title.
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
        await expect(
            service.snapshot('claude', { rootPath: root, processState: 'running' }),
        ).resolves.toMatchObject({ title: 'project-derived-name' });
    });
});
