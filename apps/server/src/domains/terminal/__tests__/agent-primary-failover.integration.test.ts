import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerEvent } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import type { IPty } from 'node-pty';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocalTerminalExecution } from '../../../__tests__/support/local-terminal-execution';
import { createTestTerminalManager } from '../../../__tests__/support/terminal';
import { CaxriDatabase } from '../../db/repository';

const temporaryDirectories: string[] = [];
const temporaryLoggers: StructuredLogger[] = [];

function createTestLogger(logDirectory: string): StructuredLogger {
    const logger = new StructuredLogger(logDirectory);
    temporaryLoggers.push(logger);
    return logger;
}

function createFakePty(): IPty {
    return {
        cols: 100,
        kill: vi.fn(),
        pid: 7_777,
        onData: vi.fn(() => ({ dispose: vi.fn() })),
        onExit: vi.fn(() => ({ dispose: vi.fn() })),
        resize: vi.fn(),
        rows: 30,
        write: vi.fn(),
    } as unknown as IPty;
}

afterEach(async () => {
    const loggers = [...temporaryLoggers];
    temporaryLoggers.length = 0;
    await Promise.all(loggers.map((logger) => logger.flush()));
    const directories = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
});

describe('TerminalManager primary Agent failover', () => {
    it('promotes a running secondary Agent when the managed primary exits', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-primary-failover-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'codex');
        const primary = created.terminal!;
        const secondary = database.createTerminal(created.session.id, 'codex');
        expect(database.rebindAgentSession(primary.id, 'codex', 'codex-session-1')).toBe(true);
        expect(database.rebindAgentSession(secondary.id, 'codex', 'codex-session-2')).toBe(true);
        const fakes = [createFakePty(), createFakePty()];
        const logger = createTestLogger(join(directory, 'logs'));
        const execution = new LocalTerminalExecution({
            logger,
            spawn: () => fakes.shift()!,
        });
        const events: ServerEvent[] = [];
        const manager = createTestTerminalManager(database, (event) => events.push(event), logger, {
            agentEnvironment: () => Promise.resolve({ PATH: '/agent/bin' }),
            agentLaunchSettings: () => ({ executable: 'codex', args: [] }),
            execution,
            lifecycleEnvironment: () => ({ CAXRI_AGENT_TEST: '1' }),
            resolveExecutable: (kind) =>
                Promise.resolve(kind === 'shell' ? '/bin/zsh' : '/bin/codex'),
        });

        try {
            await Promise.all([manager.start(primary), manager.start(secondary)]);
            await Promise.all([
                manager.waitForAgentRunning(primary.id),
                manager.waitForAgentRunning(secondary.id),
            ]);
            expect(database.getSession(created.session.id)?.primaryAgentTerminalId).toBe(
                primary.id,
            );

            expect(execution.emitAgentExit(primary.id, 0)).toBe(true);

            await vi.waitFor(() => {
                expect(database.getSession(created.session.id)?.primaryAgentTerminalId).toBe(
                    secondary.id,
                );
                expect(database.getTerminal(primary.id)?.lastAgentProcessState).toBe('stopped');
            });
            expect(database.getTerminal(primary.id)?.agentSessionId).toBe('codex-session-1');
            expect(database.getTerminal(secondary.id)?.agentSessionId).toBe('codex-session-2');
            expect(events).toContainEqual({
                event: 'state.changed',
                payload: {
                    kind: 'records',
                    sessionIds: [created.session.id],
                    terminalIds: [primary.id],
                },
            });
        } finally {
            manager.close(primary.id);
            manager.close(secondary.id);
            database.close();
        }
    });
});
