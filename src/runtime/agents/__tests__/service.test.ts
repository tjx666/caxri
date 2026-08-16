import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { StructuredLogger } from '../../../shared/node/logger';
import { clearExecutableCache, discoverExecutable } from '../discovery';
import type { AgentAdapter } from '../service';
import { AgentService } from '../service';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    clearExecutableCache();
    vi.unstubAllEnvs();
    const pendingCleanup = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(pendingCleanup.map((path) => rm(path, { recursive: true, force: true })));
});

describe('Agent adapter fallback', () => {
    it('returns unknown without failing when a CLI cannot be discovered', async () => {
        vi.stubEnv('PATH', '');
        vi.stubEnv('SHELL', '/usr/bin/false');

        await expect(
            new AgentService().snapshot('claude', { rootPath: '/definitely/missing' }),
        ).resolves.toMatchObject({
            provider: 'claude',
            status: 'unknown',
            available: false,
        });
    });

    it('validates the final executable path from login-shell output and invalidates stale cache', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-discovery-'));
        temporaryDirectories.push(directory);
        const bin = join(directory, 'bin');
        await mkdir(bin);
        const executable = join(bin, 'codex');
        const shell = join(directory, 'login-shell');
        await writeFile(executable, '#!/bin/sh\n', 'utf8');
        await chmod(executable, 0o700);
        await writeFile(
            shell,
            `#!/bin/sh\nprintf 'shell banner\\n__CAXRI_LOGIN_PATH__${bin}\\n'\n`,
            'utf8',
        );
        await chmod(shell, 0o700);
        vi.stubEnv('PATH', '');
        vi.stubEnv('SHELL', shell);

        await expect(discoverExecutable('codex')).resolves.toBe(executable);
        await chmod(executable, 0o600);
        await expect(discoverExecutable('codex')).resolves.toBeUndefined();
    });

    it('ignores terminal control sequences around a login-shell executable path', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-discovery-'));
        temporaryDirectories.push(directory);
        const bin = join(directory, 'bin');
        await mkdir(bin);
        const executable = join(bin, 'codex');
        const shell = join(directory, 'login-shell');
        await writeFile(executable, '#!/bin/sh\n', 'utf8');
        await chmod(executable, 0o700);
        await writeFile(
            shell,
            `#!/bin/sh\nprintf '\\033]1337;CurrentDir=/project\\007__CAXRI_LOGIN_PATH__${bin}\\n'\n`,
            'utf8',
        );
        await chmod(shell, 0o700);
        vi.stubEnv('PATH', '');
        vi.stubEnv('SHELL', shell);

        await expect(discoverExecutable('codex')).resolves.toBe(executable);
    });

    it('shares a concurrent provider probe', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-'));
        temporaryDirectories.push(directory);
        const snapshot = vi.fn<AgentAdapter['snapshot']>(() =>
            Promise.resolve({
                provider: 'codex',
                status: 'unknown',
                observedAt: Date.now(),
                available: true,
            }),
        );
        const logger = new StructuredLogger(join(directory, 'logs'));
        const service = new AgentService(logger, {
            claude: { provider: 'claude', snapshot },
            codex: { provider: 'codex', snapshot },
        });

        await expect(
            Promise.all([service.snapshot('codex'), service.snapshot('codex')]),
        ).resolves.toHaveLength(2);
        expect(snapshot).toHaveBeenCalledTimes(1);
        const records = (await readFile(logger.path, 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as { event: string; durationMs?: number });
        expect(records.filter((record) => record.event === 'agent.probe')).toHaveLength(1);
        expect(records.find((record) => record.event === 'agent.probe')?.durationMs).toBeTypeOf(
            'number',
        );
    });

    it('does not share a provider probe across Terminal process generations', async () => {
        const first = Promise.withResolvers<Awaited<ReturnType<AgentAdapter['snapshot']>>>();
        const second = Promise.withResolvers<Awaited<ReturnType<AgentAdapter['snapshot']>>>();
        const snapshot = vi.fn<AgentAdapter['snapshot']>((context) =>
            context.startedAt === 1 ? first.promise : second.promise,
        );
        const service = new AgentService(undefined, {
            claude: { provider: 'claude', snapshot },
            codex: { provider: 'codex', snapshot },
        });
        const firstProbe = service.snapshot('claude', {
            agentSessionId: 'same-agent-session',
            processState: 'stopped',
            rootPath: '/project',
            startedAt: 1,
        });
        await vi.waitFor(() => expect(snapshot).toHaveBeenCalledOnce());
        const secondProbe = service.snapshot('claude', {
            agentSessionId: 'same-agent-session',
            processState: 'running',
            rootPath: '/project',
            startedAt: 2,
        });

        await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));
        first.resolve({
            provider: 'claude',
            attentionKind: 'completed',
            status: 'completed',
            observedAt: 1,
            available: true,
        });
        second.resolve({
            provider: 'claude',
            status: 'running',
            observedAt: 2,
            available: true,
        });

        await expect(firstProbe).resolves.toMatchObject({ status: 'completed' });
        await expect(secondProbe).resolves.toMatchObject({ status: 'running' });
    });

    it('discovers Claude Code and Codex independently for one Project', async () => {
        const claudeSnapshot = vi.fn<AgentAdapter['snapshot']>(() =>
            Promise.resolve({
                provider: 'claude',
                status: 'waiting',
                observedAt: Date.now(),
                available: true,
                sessionId: 'claude-session-1',
            }),
        );
        const codexSnapshot = vi.fn<AgentAdapter['snapshot']>(() =>
            Promise.resolve({
                provider: 'codex',
                status: 'running',
                observedAt: Date.now(),
                available: true,
                sessionId: 'codex-session-1',
            }),
        );
        const service = new AgentService(undefined, {
            claude: { provider: 'claude', snapshot: claudeSnapshot },
            codex: { provider: 'codex', snapshot: codexSnapshot },
        });

        await expect(
            Promise.all([
                service.snapshot('claude', { rootPath: '/project' }),
                service.snapshot('codex', { rootPath: '/project' }),
            ]),
        ).resolves.toEqual([
            expect.objectContaining({ provider: 'claude', sessionId: 'claude-session-1' }),
            expect.objectContaining({ provider: 'codex', sessionId: 'codex-session-1' }),
        ]);
        expect(claudeSnapshot).toHaveBeenCalledTimes(1);
        expect(codexSnapshot).toHaveBeenCalledTimes(1);
    });
});
