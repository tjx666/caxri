import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestAgentService } from '../../__tests__/create-test-domain-services';
import { clearExecutableCache, discoverExecutable } from '../discovery';
import type { AgentAdapter } from '../service';
import { AgentService, createLocalAgentAdapters, SLOW_AGENT_PROBE_MS } from '../service';

const temporaryDirectories: string[] = [];
const loggers: StructuredLogger[] = [];

afterEach(async () => {
    clearExecutableCache();
    vi.unstubAllEnvs();
    /**
     * Async logging must finish before fixture directories are removed.
     */
    await Promise.all(loggers.map((logger) => logger.flush()));
    loggers.length = 0;
    const pendingCleanup = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(pendingCleanup.map((path) => rm(path, { recursive: true, force: true })));
});

describe('Agent adapter fallback', () => {
    it('returns unknown without failing when a CLI cannot be discovered', async () => {
        vi.stubEnv('PATH', '');
        vi.stubEnv('SHELL', '/usr/bin/false');
        /**
         * An executable name no machine installs: discovery also searches well-known install directories that do not
         * depend on PATH or HOME (`/opt/homebrew/bin`, `/usr/local/bin`), so the real `claude` name would be found on a
         * developer machine that has Claude Code installed.
         */
        const adapters = createLocalAgentAdapters(undefined, () => ({
            executable: 'caxri-test-missing-claude',
            args: [],
        }));

        await expect(
            new AgentService(undefined, adapters).snapshot('claude', {
                rootPath: '/definitely/missing',
            }),
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
        loggers.push(logger);
        const service = createTestAgentService(
            {
                claude: { provider: 'claude', snapshot },
                codex: { provider: 'codex', snapshot },
            },
            logger,
        );

        await expect(
            Promise.all([service.snapshot('codex'), service.snapshot('codex')]),
        ).resolves.toHaveLength(2);
        expect(snapshot).toHaveBeenCalledTimes(1);
        /**
         * `snapshot()` waits for the provider result, not asynchronous logger I/O. Flush the owning queue before
         * asserting against its durable file.
         */
        await logger.flush();
        const records = (await readFile(logger.path, 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as { event: string; durationMs?: number });
        expect(records.filter((record) => record.event === 'agent.probe')).toHaveLength(1);
        expect(records.find((record) => record.event === 'agent.probe')?.durationMs).toBeTypeOf(
            'number',
        );
    });

    it('logs a fast, availability-unchanged probe at debug', async () => {
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
        loggers.push(logger);
        const write = vi.spyOn(logger, 'write');
        const service = createTestAgentService({ codex: { provider: 'codex', snapshot } }, logger);

        await service.snapshot('codex');
        await service.snapshot('codex');

        const levels = write.mock.calls
            .filter((call) => call[1] === 'agent.probe')
            .map((call) => call[0]);
        /**
         * Production evidence: unconditional 'info' probes rotated real incidents out of the single 5MB log generation
         * within hours (see `SLOW_AGENT_PROBE_MS`'s JSDoc). The first probe stays at 'info' so startup timing keeps its
         * record; repeated non-transitioning probes must stay at 'debug'.
         */
        expect(levels).toEqual(['info', 'debug']);
    });

    it('logs the probe at info when availability transitions from the previous probe', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-'));
        temporaryDirectories.push(directory);
        let isAvailable = true;
        const snapshot = vi.fn<AgentAdapter['snapshot']>(() =>
            Promise.resolve({
                provider: 'codex',
                status: 'unknown',
                observedAt: Date.now(),
                available: isAvailable,
            }),
        );
        const logger = new StructuredLogger(join(directory, 'logs'));
        loggers.push(logger);
        const write = vi.spyOn(logger, 'write');
        const service = createTestAgentService({ codex: { provider: 'codex', snapshot } }, logger);

        await service.snapshot('codex');
        await service.snapshot('codex');
        isAvailable = false;
        await service.snapshot('codex');

        const levels = write.mock.calls
            .filter((call) => call[1] === 'agent.probe')
            .map((call) => call[0]);
        expect(levels).toEqual(['info', 'debug', 'info']);
    });

    it('logs the probe at info when it exceeds the slow-probe threshold, even without an availability change', async () => {
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
        loggers.push(logger);
        const write = vi.spyOn(logger, 'write');
        const service = createTestAgentService({ codex: { provider: 'codex', snapshot } }, logger);
        const now = vi
            .spyOn(performance, 'now')
            .mockReturnValueOnce(0)
            .mockReturnValueOnce(SLOW_AGENT_PROBE_MS + 1);

        try {
            await service.snapshot('codex');
            const call = write.mock.calls.find((entry) => entry[1] === 'agent.probe');
            expect(call?.[0]).toBe('info');
        } finally {
            now.mockRestore();
        }
    });

    it('attributes the probe log to its Terminal via correlationId', async () => {
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
        loggers.push(logger);
        const write = vi.spyOn(logger, 'write');
        const service = createTestAgentService({ codex: { provider: 'codex', snapshot } }, logger);

        await service.snapshot('codex', { rootPath: '/project', correlationId: 'terminal-42' });

        const call = write.mock.calls.find((entry) => entry[1] === 'agent.probe');
        expect(call?.[2]?.correlationId).toBe('terminal-42');
    });

    /**
     * `durationMs` cannot say whether a provider's cache regressed, because it moves with machine load. The hit rate
     * can, but only if it is on every record, including the 'debug' ones an idle Terminal produces, which are almost
     * all of them. A provider with no cache must add nothing, so the field set stays exactly what it was.
     */
    it('carries a provider cache counter on every probe record, including debug ones', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-'));
        temporaryDirectories.push(directory);
        const snapshot = vi.fn<AgentAdapter['snapshot']>(() =>
            Promise.resolve({
                provider: 'claude',
                status: 'unknown',
                observedAt: Date.now(),
                available: true,
            }),
        );
        const logger = new StructuredLogger(join(directory, 'logs'));
        loggers.push(logger);
        const write = vi.spyOn(logger, 'write');
        const service = createTestAgentService(
            {
                claude: {
                    provider: 'claude',
                    snapshot,
                    probeCacheCounters: () => ({
                        cold: 3,
                        hits: 7,
                        listingReads: 1,
                        misses: 3,
                    }),
                },
                codex: { provider: 'codex', snapshot },
            },
            logger,
        );

        await service.snapshot('claude');
        await service.snapshot('claude');
        await service.snapshot('codex');

        const records = write.mock.calls.filter((entry) => entry[1] === 'agent.probe');
        // The third is Codex's first probe, so it is a transition and stays at 'info'.
        expect(records.map((entry) => entry[0])).toEqual(['info', 'debug', 'info']);
        for (const record of records.slice(0, 2))
            expect(record[2]?.fields).toMatchObject({
                'cache.cold': 3,
                'cache.hits': 7,
                'cache.listingReads': 1,
                'cache.misses': 3,
            });
        expect(Object.keys(records[2]?.[2]?.fields ?? {})).toEqual(['provider', 'available']);
    });

    it('does not share a provider probe across Terminal process generations', async () => {
        const first = Promise.withResolvers<Awaited<ReturnType<AgentAdapter['snapshot']>>>();
        const second = Promise.withResolvers<Awaited<ReturnType<AgentAdapter['snapshot']>>>();
        const snapshot = vi.fn<AgentAdapter['snapshot']>((context) =>
            context.startedAt === 1 ? first.promise : second.promise,
        );
        const service = createTestAgentService({
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
        const service = createTestAgentService({
            claude: {
                provider: 'claude',
                snapshot: claudeSnapshot,
            },
            codex: {
                provider: 'codex',
                snapshot: codexSnapshot,
            },
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

    it('delegates session rename to the selected provider without changing its inputs or result', async () => {
        const signal = new AbortController().signal;
        const context = {
            agentSessionId: 'codex-session-1',
            cwd: '/project',
            title: 'Requested title',
            signal,
        };
        const renameSession = vi.fn<AgentAdapter['renameSession']>(() =>
            Promise.resolve({ title: 'Provider title' }),
        );
        const claudeRenameSession = vi.fn<AgentAdapter['renameSession']>();
        const snapshot = vi.fn<AgentAdapter['snapshot']>();
        const service = createTestAgentService({
            claude: { provider: 'claude', renameSession: claudeRenameSession, snapshot },
            codex: { provider: 'codex', renameSession, snapshot },
        });

        await expect(service.renameSession('codex', context)).resolves.toEqual({
            title: 'Provider title',
        });
        expect(renameSession).toHaveBeenCalledOnce();
        expect(renameSession).toHaveBeenCalledWith(context);
        expect(renameSession.mock.calls[0]?.[0]).toBe(context);
        expect(renameSession.mock.calls[0]?.[0].signal).toBe(signal);
        expect(claudeRenameSession).not.toHaveBeenCalled();
    });

    it('passes through provider session rename errors', async () => {
        const error = new Error('rename failed');
        const renameSession = vi.fn<AgentAdapter['renameSession']>(() => Promise.reject(error));
        const snapshot = vi.fn<AgentAdapter['snapshot']>();
        const service = createTestAgentService({
            claude: { provider: 'claude', renameSession, snapshot },
        });

        await expect(
            service.renameSession('claude', {
                agentSessionId: 'claude-session-1',
                cwd: '/project',
                title: 'Requested title',
            }),
        ).rejects.toBe(error);
    });

    it('delegates low-cost text generation only to the selected provider', async () => {
        const context = { cwd: '/project', prompt: 'session title fixture' };
        const generateTitle = vi.fn<NonNullable<AgentAdapter['generateTitle']>>(() =>
            Promise.resolve('Compact title'),
        );
        const claudeGenerateTitle = vi.fn<NonNullable<AgentAdapter['generateTitle']>>();
        const service = createTestAgentService({
            claude: { provider: 'claude', generateTitle: claudeGenerateTitle },
            codex: { provider: 'codex', generateTitle },
        });

        await expect(service.generateTitle('codex', context)).resolves.toBe('Compact title');
        expect(generateTitle).toHaveBeenCalledWith(context);
        expect(claudeGenerateTitle).not.toHaveBeenCalled();
    });
});
