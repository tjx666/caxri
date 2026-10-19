import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it } from 'vitest';

import type { AgentLifecycleSignal } from '../hooks/contract';
import { AgentMaintenanceTurns } from '../maintenance-turns';

const directories: string[] = [];
const loggers: StructuredLogger[] = [];

afterEach(async () => {
    const pendingLoggers = [...loggers];
    loggers.length = 0;
    await Promise.all(pendingLoggers.map((logger) => logger.flush()));
    const pendingDirectories = [...directories];
    directories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

async function createTurns(timeoutMs = 60_000): Promise<AgentMaintenanceTurns> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-maintenance-turns-'));
    directories.push(directory);
    const logger = new StructuredLogger(join(directory, 'logs'));
    loggers.push(logger);
    return new AgentMaintenanceTurns(timeoutMs, logger);
}

const signal = (phase: AgentLifecycleSignal['phase']): AgentLifecycleSignal => ({
    launchId: 'launch',
    phase,
    provider: 'claude',
    terminalId: 'terminal',
});

describe('AgentMaintenanceTurns', () => {
    it('absorbs nothing without an open window', async () => {
        const turns = await createTurns();
        expect(turns.absorb(signal('turnStarted'))).toBe(false);
    });

    it('lets attention through and closes on a compaction that reports no turn', async () => {
        const turns = await createTurns();
        turns.begin('terminal');
        expect(turns.absorb(signal('attentionRequested'))).toBe(false);
        expect(turns.absorb(signal('compactionStarted'))).toBe(true);
        expect(turns.absorb(signal('compactionFinished'))).toBe(true);
        expect(turns.holds('terminal')).toBe(false);
    });

    it('releases a second turn, which is someone else’s work', async () => {
        const turns = await createTurns();
        turns.begin('terminal');
        expect(turns.absorb(signal('turnStarted'))).toBe(true);
        expect(turns.absorb(signal('compactionFinished'))).toBe(true);
        expect(turns.holds('terminal')).toBe(true);
        expect(turns.absorb(signal('turnStarted'))).toBe(false);
        expect(turns.holds('terminal')).toBe(false);
    });

    it('expires a window whose completion never arrives', async () => {
        const turns = await createTurns(5);
        turns.begin('terminal');
        await expect.poll(() => turns.holds('terminal')).toBe(false);
    });
});
