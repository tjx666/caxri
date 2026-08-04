import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentService, type AgentAdapter } from '../agent';
import { StructuredLogger } from '../logger';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
});

describe('Agent adapter fallback', () => {
    it('returns unknown without failing when a CLI cannot be discovered', async () => {
        vi.stubEnv('PATH', '');
        vi.stubEnv('SHELL', '/usr/bin/false');

        await expect(new AgentService().snapshot('claude')).resolves.toMatchObject({
            provider: 'claude',
            status: 'unknown',
            available: false,
        });
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
});
