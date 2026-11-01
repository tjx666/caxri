import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestAgentService } from '../../__tests__/create-test-domain-services';
import { CaxriDatabase } from '../../db/repository';
import { AgentCoordinator } from '../coordinator';
import type { AgentAdapter } from '../service';

const loggers: StructuredLogger[] = [];

function createLogger(...arguments_: ConstructorParameters<typeof StructuredLogger>) {
    const logger = new StructuredLogger(...arguments_);
    loggers.push(logger);
    return logger;
}

async function flushLoggers(): Promise<void> {
    const pendingLoggers = [...loggers];
    loggers.length = 0;
    await Promise.all(pendingLoggers.map((logger) => logger.flush()));
}
const temporaryDirectories: string[] = [];

function createAgents(snapshot: AgentAdapter['snapshot']) {
    return createTestAgentService({
        claude: { provider: 'claude', snapshot },
        codex: { provider: 'codex', snapshot },
    });
}

afterEach(async () => {
    await flushLoggers();
    const pendingCleanup = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(pendingCleanup.map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * The Server observes terminal input only after the acknowledged PTY write resolves, so on a loaded host a quiet
 * relaunched Agent's output can precede the promotion candidate.
 */
describe('AgentCoordinator alias relaunch ordering', () => {
    it('probes a quiet alias relaunch whose output was observed before the input', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-shell-alias-late-input-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'codex');
        const terminalId = created.terminal!.id;
        database.updateTerminalState(terminalId, 'running');
        database.updateAgentProcessState(terminalId, 'stopped');
        const detectForegroundAgent = vi.fn(() => Promise.resolve('codex' as const));
        const snapshot = vi.fn<AgentAdapter['snapshot']>(() =>
            Promise.resolve({
                provider: 'codex',
                status: 'idle',
                observedAt: Date.now(),
                available: true,
            }),
        );
        const coordinator = new AgentCoordinator(
            database,
            createAgents(snapshot),
            () => {},
            createLogger(join(directory, 'logs')),
            { detectForegroundAgent, refreshDelayMs: 5, shellProcessProbeIntervalMs: 20 },
        );

        try {
            /**
             * The Server observes input only after the acknowledged PTY write resolves, so on a loaded host the echo
             * and a quiet Agent's startup line can both be observed before the candidate exists. No later output
             * follows.
             */
            coordinator.observeOutput(terminalId, 4242);
            coordinator.observeOutput(terminalId, 4242);
            coordinator.observeInput(terminalId, 'cc\r');

            await expect
                .poll(() => database.getTerminal(terminalId)?.lastAgentProcessState)
                .toBe('running');
        } finally {
            await coordinator.close();
            database.close();
        }
    });
});
