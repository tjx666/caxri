import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TerminalRecord, TerminalSnapshot } from '@caxri/protocol';
import { MAX_TERMINAL_INPUT_LENGTH } from '@caxri/protocol';
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
    private readonly inputResolvers: Array<() => void> = [];
    private readonly resizeResolvers: Array<() => void> = [];
    readonly requests: Array<{ request: TerminalHostRequest; scope: TerminalHostScope }> = [];
    holdInputRequests = false;
    holdResizeRequests = false;

    diagnostics(): ReturnType<TerminalHostControl['diagnostics']> {
        return {
            state: 'ready',
            pid: 4242,
            startedAt: 1,
            restartCount: 0,
            pendingRequestCount: this.inputResolvers.length + this.resizeResolvers.length,
        };
    }

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
            case 'terminal.input':
                if (!this.holdInputRequests) return Promise.resolve({ accepted: true });
                return new Promise((resolve) =>
                    this.inputResolvers.push(() => resolve({ accepted: true })),
                );
            case 'terminal.resize':
                if (!this.holdResizeRequests) return Promise.resolve({ accepted: true });
                return new Promise((resolve) =>
                    this.resizeResolvers.push(() => resolve({ accepted: true })),
                );
            default:
                return Promise.resolve({ accepted: true });
        }
    }

    releaseInput(): void {
        this.inputResolvers.shift()?.();
    }

    releaseResize(): void {
        this.resizeResolvers.shift()?.();
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
        const themeTerminalColors = {
            background: '#111111',
            foreground: '#eeeeee',
            cursor: '#ffffff',
        };
        execution.onEvent(output);
        await expect(execution.attach(terminal.id, { cols: 120, rows: 40 })).resolves.toEqual({
            snapshot: null,
            wasAttached: false,
        });
        await execution.reserve(terminal);
        await execution.start({
            args: ['-l'],
            colors: themeTerminalColors,
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
        expect(control.requests[2]?.request).toMatchObject({
            method: 'terminal.start',
            params: {
                colors: { background: '#111111', foreground: '#eeeeee' },
            },
        });
        expect(attach.scope).toMatchObject({ ptyGeneration: 1 });
        expect(execution.write(terminal.id, 'echo safe\r')).toBe(true);
        await vi.waitFor(() =>
            expect(control.requests.at(-1)!.request.method).toBe('terminal.input'),
        );

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

    it('coalesces burst input without changing byte order', async () => {
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

        const chunks = Array.from({ length: 300 }, (_, index) => `${index},`);
        for (const chunk of chunks) expect(execution.write(terminal.id, chunk)).toBe(true);

        await vi.waitFor(() => {
            const inputs = control.requests.filter(
                ({ request }) => request.method === 'terminal.input',
            );
            expect(inputs).toHaveLength(1);
            expect(inputs[0].request).toEqual({
                method: 'terminal.input',
                params: { data: chunks.join('') },
            });
        });
    });

    it('bounds accepted input and keeps one private request in flight per Terminal', async () => {
        const { control, execution } = createExecution();
        control.holdInputRequests = true;
        await execution.attach(terminal.id);
        await execution.reserve(terminal);
        await execution.start({
            args: [],
            environment: {},
            executable: '/bin/zsh',
            initialSnapshot: null,
            record: terminal,
        });
        const maximumChunk = 'x'.repeat(MAX_TERMINAL_INPUT_LENGTH);

        for (let index = 0; index < 4; index += 1)
            expect(execution.write(terminal.id, maximumChunk)).toBe(true);
        expect(() => execution.write(terminal.id, 'overflow')).toThrow(
            expect.objectContaining({ code: 'CAPACITY' }),
        );

        for (let expectedRequests = 1; expectedRequests <= 4; expectedRequests += 1) {
            // eslint-disable-next-line no-await-in-loop -- Each release proves the next request waits for the prior reply.
            await vi.waitFor(() =>
                expect(
                    control.requests.filter(({ request }) => request.method === 'terminal.input'),
                ).toHaveLength(expectedRequests),
            );
            control.releaseInput();
        }
        await vi.waitFor(() => expect(execution.write(terminal.id, 'accepted-again')).toBe(true));
        await vi.waitFor(() =>
            expect(
                control.requests.filter(({ request }) => request.method === 'terminal.input'),
            ).toHaveLength(5),
        );
        control.releaseInput();
    });

    it('collapses resize bursts to the latest dimensions', async () => {
        const { control, execution } = createExecution();
        control.holdResizeRequests = true;
        await execution.attach(terminal.id);
        await execution.reserve(terminal);
        await execution.start({
            args: [],
            environment: {},
            executable: '/bin/zsh',
            initialSnapshot: null,
            record: terminal,
        });

        for (let index = 0; index < 300; index += 1)
            expect(execution.resize(terminal.id, 80 + index, 24 + index)).toBe(true);

        await vi.waitFor(() => {
            const resizes = control.requests.filter(
                ({ request }) => request.method === 'terminal.resize',
            );
            expect(resizes).toHaveLength(1);
            expect(resizes[0].request).toEqual({
                method: 'terminal.resize',
                params: { cols: 379, rows: 323 },
            });
        });
        control.releaseResize();
    });

    it('drains accepted input before stopping a Terminal', async () => {
        const { control, execution } = createExecution();
        control.holdInputRequests = true;
        await execution.attach(terminal.id);
        await execution.reserve(terminal);
        await execution.start({
            args: [],
            environment: {},
            executable: '/bin/zsh',
            initialSnapshot: null,
            record: terminal,
        });

        expect(execution.write(terminal.id, 'exit\r')).toBe(true);
        execution.close(terminal.id);
        await vi.waitFor(() =>
            expect(control.requests.at(-1)!.request.method).toBe('terminal.input'),
        );
        expect(control.requests.some(({ request }) => request.method === 'terminal.stop')).toBe(
            false,
        );

        control.releaseInput();
        await vi.waitFor(() =>
            expect(control.requests.at(-1)!.request.method).toBe('terminal.stop'),
        );
    });

    it('does not start an empty Terminal Host to detach an unreserved view', async () => {
        const { control, execution } = createExecution();
        await execution.attach(terminal.id);

        execution.detachAllViews();

        expect(control.requests).toEqual([]);
    });

    it('reports content-free lifecycle, ownership, and pressure counters', async () => {
        const { control, execution } = createExecution();
        control.holdInputRequests = true;
        control.holdResizeRequests = true;
        await execution.attach(terminal.id, { cols: 120, rows: 40 });
        await execution.reserve(terminal);
        await execution.start({
            args: [],
            environment: {},
            executable: '/bin/zsh',
            initialSnapshot: null,
            record: terminal,
        });
        execution.write(terminal.id, 'private-input');
        execution.resize(terminal.id, 121, 41);

        await vi.waitFor(() =>
            expect(execution.diagnostics()).toEqual({
                state: 'ready',
                pid: 4242,
                startedAt: 1,
                restartCount: 0,
                pendingRequestCount: 2,
                activeTerminalCount: 1,
                attachedTerminalCount: 1,
                inputQueueCount: 1,
                queuedInputCharacters: 13,
                resizeQueueCount: 1,
            }),
        );
        expect(JSON.stringify(execution.diagnostics())).not.toContain('private-input');
        control.releaseInput();
        control.releaseResize();
    });
});
