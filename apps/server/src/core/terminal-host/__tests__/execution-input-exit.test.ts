import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TerminalSnapshot } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
    TerminalHostMessage,
    TerminalHostRequest,
    TerminalHostScope,
} from '../../../terminal-host/protocol';
import { RemoteTerminalExecution } from '../execution';
import type { TerminalHostControl } from '../execution-contract';
import { snapshot, terminal } from './execution-fixtures';

type HostEvent = Exclude<Extract<TerminalHostMessage, { type: 'event' }>, { event: 'host.ready' }>;

const temporaryDirectories: string[] = [];

class InputExitTerminalHostControl implements TerminalHostControl {
    private readonly eventListeners = new Set<(event: HostEvent) => void>();
    private readonly input = Promise.withResolvers<{ accepted: boolean }>();
    readonly requests: Array<{ request: TerminalHostRequest; scope: TerminalHostScope }> = [];

    emit(event: HostEvent): void {
        for (const listener of this.eventListeners) listener(event);
    }

    onEvent(listener: (event: HostEvent) => void): () => void {
        this.eventListeners.add(listener);
        return () => this.eventListeners.delete(listener);
    }

    onExit(): () => void {
        return () => {};
    }

    isRunning(): boolean {
        return true;
    }

    request(request: TerminalHostRequest, scope: TerminalHostScope): Promise<unknown> {
        this.requests.push({ request, scope });
        if (request.method === 'terminal.reserve') return Promise.resolve({ reserved: true });
        if (request.method === 'terminal.attach')
            return Promise.resolve({ snapshot: null, wasAttached: false });
        if (request.method === 'terminal.start') return Promise.resolve({ processId: 4243 });
        if (request.method === 'terminal.input') return this.input.promise;
        return Promise.resolve({ accepted: true });
    }

    releaseInput(): void {
        this.input.resolve({ accepted: true });
    }

    shutdown(): Promise<{ failures: never[]; snapshots: TerminalSnapshot[] }> {
        return Promise.resolve({ failures: [], snapshots: [] });
    }
}

function createExecution(): {
    control: InputExitTerminalHostControl;
    execution: RemoteTerminalExecution;
    logger: StructuredLogger;
} {
    const directory = mkdtempSync(join(tmpdir(), 'caxri-terminal-input-exit-'));
    temporaryDirectories.push(directory);
    const control = new InputExitTerminalHostControl();
    const logger = new StructuredLogger(join(directory, 'logs'), 'server-core');
    return { control, execution: new RemoteTerminalExecution(control, logger), logger };
}

afterEach(() => {
    for (const directory of temporaryDirectories)
        rmSync(directory, { force: true, recursive: true });
    temporaryDirectories.length = 0;
});

describe('RemoteTerminalExecution input exit ordering', () => {
    it('acknowledges delivered input and rejects later input when exit overtakes its reply', async () => {
        const { control, execution } = createExecution();
        await execution.attach(terminal.id);
        await execution.reserve(terminal);
        await execution.start({
            args: [],
            environment: {},
            executable: '/bin/zsh',
            initialSnapshot: null,
            record: terminal,
        });

        const delivered = execution.writeAcknowledged(terminal.id, 'kill -9 $$\r');
        await vi.waitFor(() =>
            expect(control.requests.at(-1)?.request.method).toBe('terminal.input'),
        );
        const notDelivered = execution.writeAcknowledged(terminal.id, 'echo too late\r');
        control.emit({
            type: 'event',
            event: 'terminal.exit',
            identity: {
                scope: 'terminal',
                sessionId: terminal.sessionId,
                terminalId: terminal.id,
                ptyGeneration: 1,
            },
            exitCode: 137,
            signal: 9,
            snapshot,
        });
        control.releaseInput();

        await expect(delivered).resolves.toBe(true);
        await expect(notDelivered).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    });

    it('does not warn when an accepted private reply arrives after caller cancellation', async () => {
        const { control, execution, logger } = createExecution();
        const writeLog = vi.spyOn(logger, 'write');
        await execution.attach(terminal.id);
        await execution.reserve(terminal);
        await execution.start({
            args: [],
            environment: {},
            executable: '/bin/zsh',
            initialSnapshot: null,
            record: terminal,
        });
        const cancellation = new AbortController();
        const cancelled = execution.writeAcknowledged(
            terminal.id,
            'echo cancelled\r',
            cancellation.signal,
        );
        await vi.waitFor(() =>
            expect(control.requests.at(-1)?.request.method).toBe('terminal.input'),
        );

        cancellation.abort();
        await expect(cancelled).rejects.toMatchObject({ code: 'CANCELLED' });
        control.releaseInput();
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(writeLog).not.toHaveBeenCalled();
    });
});
