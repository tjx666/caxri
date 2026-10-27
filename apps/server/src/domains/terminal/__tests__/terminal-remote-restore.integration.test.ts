import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TerminalRecord, TerminalSnapshot } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestTerminalManager } from '../../../__tests__/support/terminal';
import { RemoteTerminalExecution } from '../../../core/terminal-host/execution';
import type { TerminalHostControl } from '../../../core/terminal-host/execution-contract';
import type { TerminalHostRequest, TerminalHostScope } from '../../../terminal-host/protocol';
import { CaxriDatabase } from '../../db/repository';
import { TerminalRestoreSupervisor } from '../restore-supervisor';

const terminal: TerminalRecord = {
    id: 'terminal-1',
    sessionId: 'session-1',
    cwd: '/project',
    kind: 'shell',
    title: 'Shell',
    orderIndex: 0,
    lastProcessState: 'starting',
    createdAt: 1,
    updatedAt: 1,
};
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

class RestoreTerminalHostControl implements TerminalHostControl {
    readonly requests: Array<{ request: TerminalHostRequest; scope: TerminalHostScope }> = [];
    resolveAttachedSizeWaits = false;

    onEvent(): () => void {
        return () => {};
    }

    onExit(): () => void {
        return () => {};
    }

    isRunning(): boolean {
        return true;
    }

    request(
        request: TerminalHostRequest,
        scope: TerminalHostScope,
        signal?: AbortSignal,
    ): Promise<unknown> {
        this.requests.push({ request, scope });
        if (request.method === 'terminal.reserve') return Promise.resolve({ reserved: true });
        if (request.method === 'terminal.start') return Promise.resolve({ processId: 4243 });
        if (request.method !== 'terminal.waitForAttachedSize')
            return Promise.resolve({ accepted: true });
        if (this.resolveAttachedSizeWaits) return Promise.resolve({ attached: true });
        return new Promise((_resolve, reject) => {
            const cancel = (): void =>
                reject(
                    new CaxriError(
                        'CANCELLED',
                        'Terminal Host request cancelled: terminal.waitForAttachedSize',
                    ),
                );
            if (signal?.aborted) cancel();
            else signal?.addEventListener('abort', cancel, { once: true });
        });
    }

    shutdown(): Promise<{ failures: never[]; snapshots: TerminalSnapshot[] }> {
        return Promise.resolve({ failures: [], snapshots: [] });
    }
}

function createExecution(): {
    control: RestoreTerminalHostControl;
    execution: RemoteTerminalExecution;
    logger: StructuredLogger;
} {
    const directory = mkdtempSync(join(tmpdir(), 'caxri-remote-terminal-restore-'));
    temporaryDirectories.push(directory);
    const control = new RestoreTerminalHostControl();
    const logger = createLogger(join(directory, 'logs'), 'server-core');
    return { control, execution: new RemoteTerminalExecution(control, logger), logger };
}

afterEach(async () => {
    await flushLoggers();
    for (const directory of temporaryDirectories)
        rmSync(directory, { force: true, recursive: true });
    temporaryDirectories.length = 0;
});

describe('remote Terminal restoration', () => {
    it('treats an aborted attached-size wait as stale restore completion', async () => {
        const { control, execution } = createExecution();
        await execution.reserve(terminal);
        const cancellation = new AbortController();
        const waiting = execution.waitForAttachedSize(terminal.id, 1_000, cancellation.signal);

        cancellation.abort();

        await expect(waiting).resolves.toBeUndefined();
        expect(control.requests.at(-1)?.request.method).toBe('terminal.waitForAttachedSize');
    });

    it('restores an interrupted Terminal after a Session switch cancels its remote grid wait', async () => {
        const { control, execution, logger } = createExecution();
        const directory = mkdtempSync(join(tmpdir(), 'caxri-remote-terminal-state-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const project = database.createProject(directory);
        const first = database.createSession(project.id, 'shell');
        const second = database.createSession(project.id, null);
        const interrupted = first.terminal!;
        database.updateTerminalState(interrupted.id, 'interrupted');
        const manager = createTestTerminalManager(database, () => {}, logger, {
            execution,
            resolveExecutable: () => Promise.resolve('/bin/zsh'),
        });
        const restores = new TerminalRestoreSupervisor(1);
        const restoreFirstSession = () =>
            restores.restore(first.session.id, [
                async (isCurrent, abortSignal) => {
                    const restarted = await manager.restart(interrupted.id, {
                        abortSignal,
                        shouldStart: isCurrent,
                        waitForAttachedSizeMs: 1_000,
                    });
                    return restarted.lastProcessState === 'running';
                },
            ]);

        try {
            const firstAttempt = restoreFirstSession();
            await vi.waitFor(() =>
                expect(
                    control.requests.filter(
                        ({ request }) => request.method === 'terminal.waitForAttachedSize',
                    ),
                ).toHaveLength(1),
            );

            await expect(restores.restore(second.session.id, [])).resolves.toEqual([]);
            await expect(firstAttempt).resolves.toEqual([false]);
            expect(database.getTerminal(interrupted.id)).toMatchObject({
                lastProcessState: 'interrupted',
                failureReason: undefined,
            });

            control.resolveAttachedSizeWaits = true;
            await expect(restoreFirstSession()).resolves.toEqual([true]);
            expect(database.getTerminal(interrupted.id)).toMatchObject({
                lastProcessState: 'running',
                failureReason: undefined,
            });
            expect(
                control.requests.filter(({ request }) => request.method === 'terminal.start'),
            ).toHaveLength(1);
        } finally {
            restores.close();
            manager.close(interrupted.id);
            database.close();
        }
    });
});
