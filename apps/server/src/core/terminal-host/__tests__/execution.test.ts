import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TerminalRecord, TerminalSnapshot } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
    TerminalHostMessage,
    TerminalHostRequest,
    TerminalHostScope,
} from '../../../terminal-host/protocol';
import type { TerminalHostControl } from '../execution';
import { RemoteTerminalExecution } from '../execution';

type HostEvent = Exclude<Extract<TerminalHostMessage, { type: 'event' }>, { event: 'host.ready' }>;

const terminal: TerminalRecord = {
    id: 'terminal-1',
    sessionId: 'session-1',
    cwd: '/project',
    kind: 'shell',
    title: 'Shell',
    icon: 'terminal',
    orderIndex: 0,
    lastProcessState: 'starting',
    createdAt: 1,
    updatedAt: 1,
};
const snapshot: TerminalSnapshot = {
    terminalId: terminal.id,
    encodingVersion: 1,
    cols: 120,
    rows: 40,
    lineCount: 1,
    byteCount: 6,
    payload: 'screen',
    updatedAt: 2,
};
const temporaryDirectories: string[] = [];

class FakeTerminalHostControl implements TerminalHostControl {
    private readonly eventListeners = new Set<(event: HostEvent) => void>();
    private readonly exitListeners = new Set<
        (event: { code: number; signal: NodeJS.Signals | null }) => void
    >();
    readonly requests: Array<{ request: TerminalHostRequest; scope: TerminalHostScope }> = [];

    emit(event: HostEvent): void {
        for (const listener of this.eventListeners) listener(event);
    }

    exit(code = 9): void {
        for (const listener of this.exitListeners) listener({ code, signal: null });
    }

    onEvent(listener: (event: HostEvent) => void): () => void {
        this.eventListeners.add(listener);
        return () => this.eventListeners.delete(listener);
    }

    onExit(listener: (event: { code: number; signal: NodeJS.Signals | null }) => void): () => void {
        this.exitListeners.add(listener);
        return () => this.exitListeners.delete(listener);
    }

    request(request: TerminalHostRequest, scope: TerminalHostScope): Promise<unknown> {
        this.requests.push({ request, scope });
        switch (request.method) {
            case 'terminal.reserve':
                return Promise.resolve({ reserved: true });
            case 'terminal.attach':
                return Promise.resolve({ snapshot: null, wasAttached: false });
            case 'terminal.start':
                return Promise.resolve({ processId: 4243 });
            case 'terminal.stop':
                return Promise.resolve({ snapshot, stopped: true });
            default:
                return Promise.resolve({ accepted: true });
        }
    }

    shutdown(): Promise<TerminalSnapshot[]> {
        return Promise.resolve([snapshot]);
    }
}

function createExecution(): {
    control: FakeTerminalHostControl;
    execution: RemoteTerminalExecution;
} {
    const directory = mkdtempSync(join(tmpdir(), 'caxri-remote-terminal-execution-'));
    temporaryDirectories.push(directory);
    const control = new FakeTerminalHostControl();
    return {
        control,
        execution: new RemoteTerminalExecution(
            control,
            new StructuredLogger(join(directory, 'logs'), 'server-core'),
        ),
    };
}

afterEach(() => {
    for (const directory of temporaryDirectories)
        rmSync(directory, { force: true, recursive: true });
    temporaryDirectories.length = 0;
});

describe('RemoteTerminalExecution', () => {
    it('replays a pre-launch view reservation and preserves synchronous input acceptance', async () => {
        const { control, execution } = createExecution();
        const output = vi.fn();
        execution.onEvent(output);
        await expect(execution.attach(terminal.id, { cols: 120, rows: 40 })).resolves.toEqual({
            snapshot: null,
            wasAttached: false,
        });
        await execution.reserve(terminal);
        await execution.start({
            args: ['-l'],
            environment: { TERM: 'xterm-256color' },
            executable: '/bin/zsh',
            initialSnapshot: null,
            record: terminal,
        });

        expect(control.requests.map(({ request }) => request.method)).toEqual([
            'terminal.reserve',
            'terminal.attach',
            'terminal.start',
        ]);
        const attach = control.requests[1];
        expect(attach.scope).toMatchObject({ ptyGeneration: 1 });
        expect(execution.write(terminal.id, 'echo safe\r')).toBe(true);
        expect(control.requests.at(-1)!.request.method).toBe('terminal.input');

        const attachmentId = (
            attach.request as Extract<TerminalHostRequest, { method: 'terminal.attach' }>
        ).params.attachmentId;
        control.emit({
            type: 'event',
            event: 'terminal.output',
            identity: {
                scope: 'terminal',
                sessionId: terminal.sessionId,
                terminalId: terminal.id,
                ptyGeneration: 2,
                attachmentId,
            },
            data: 'stale',
        });
        control.emit({
            type: 'event',
            event: 'terminal.output',
            identity: {
                scope: 'terminal',
                sessionId: terminal.sessionId,
                terminalId: terminal.id,
                ptyGeneration: 1,
                attachmentId,
            },
            data: 'current',
        });
        expect(output).toHaveBeenCalledOnce();
        expect(output).toHaveBeenCalledWith({
            type: 'output',
            terminalId: terminal.id,
            data: 'current',
        });
    });

    it('fences lost PTYs while preserving the next monotonic Core generation', async () => {
        const { control, execution } = createExecution();
        const hostExit = vi.fn();
        execution.onHostExit(hostExit);
        await execution.reserve(terminal);
        await execution.start({
            args: [],
            environment: {},
            executable: '/bin/zsh',
            initialSnapshot: null,
            record: terminal,
        });
        control.exit();

        expect(hostExit).toHaveBeenCalledWith([terminal.id]);
        expect(execution.processId(terminal.id)).toBeUndefined();
        await execution.reserve(terminal);
        const reserve = control.requests.findLast(
            ({ request }) => request.method === 'terminal.reserve',
        )!;
        expect(reserve.scope).toMatchObject({ ptyGeneration: 2 });
    });

    it('returns the final snapshot before opening the next generation', async () => {
        const { control, execution } = createExecution();
        await execution.reserve(terminal);
        await execution.start({
            args: [],
            environment: {},
            executable: '/bin/zsh',
            initialSnapshot: null,
            record: terminal,
        });
        await expect(execution.restartBarrier(terminal.id)).resolves.toEqual(snapshot);
        await execution.reserve(terminal);
        expect(control.requests.at(-1)!.scope).toMatchObject({ ptyGeneration: 2 });
    });
});
