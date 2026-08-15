import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    it('reads Claude Code live-session metadata without opening transcripts', async () => {
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
});
