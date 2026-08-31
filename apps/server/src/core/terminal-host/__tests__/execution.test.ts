import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TerminalRecord, TerminalSnapshot } from '@caxri/protocol';
import { MAX_TERMINAL_INPUT_LENGTH, MAX_TERMINAL_INPUT_PAYLOAD_LENGTH } from '@caxri/protocol';
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
    private readonly inputResolvers: Array<{ resolve(): void }> = [];
    private readonly resizeResolvers: Array<() => void> = [];
    declineNextInput = false;
    failNextInput?: Error;
    readonly requests: Array<{ request: TerminalHostRequest; scope: TerminalHostScope }> = [];
    holdInputRequests = false;
    holdResizeRequests = false;

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

    request(
        request: TerminalHostRequest,
        scope: TerminalHostScope,
        signal?: AbortSignal,
    ): Promise<unknown> {
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
                if (this.declineNextInput) {
                    this.declineNextInput = false;
                    return Promise.resolve({ accepted: false });
                }
                if (this.failNextInput) {
                    const error = this.failNextInput;
                    this.failNextInput = undefined;
                    return Promise.reject(error);
                }
                if (!this.holdInputRequests) return Promise.resolve({ accepted: true });
                return new Promise((resolve, reject) => {
                    let isSettled = false;
                    const abort = (): void => {
                        if (isSettled) return;
                        isSettled = true;
                        signal?.removeEventListener('abort', abort);
                        reject(new Error('input aborted'));
                    };
                    signal?.addEventListener('abort', abort, { once: true });
                    this.inputResolvers.push({
                        resolve() {
                            if (isSettled) return;
                            isSettled = true;
                            signal?.removeEventListener('abort', abort);
                            resolve({ accepted: true });
                        },
                    });
                });
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
        this.inputResolvers.shift()?.resolve();
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
    const logger = new StructuredLogger(join(directory, 'logs'), 'server-core');
    return {
        control,
        execution: new RemoteTerminalExecution(control, logger),
    };
}

afterEach(() => {
    for (const directory of temporaryDirectories)
        rmSync(directory, { force: true, recursive: true });
    temporaryDirectories.length = 0;
});

describe('architecture-a3b-terminal-host: RemoteTerminalExecution', () => {
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

    it('projects only the current managed Agent launch and signals it by exact identity', async () => {
        const { control, execution } = createExecution();
        const events = vi.fn();
        execution.onEvent(events);
        await execution.reserve(terminal);
        await execution.start({
            args: ['-l'],
            environment: { TERM: 'xterm-256color' },
            executable: '/bin/zsh',
            initialSnapshot: null,
            record: terminal,
            agent: {
                launchId: 'launch-1',
                provider: 'codex',
                executable: '/usr/local/bin/codex',
                args: ['resume', 'session-1'],
                environment: { CAXRI_ENDPOINT_REF: 'endpoint-1' },
            },
        });

        expect(control.requests.at(-1)?.request).toMatchObject({
            method: 'terminal.start',
            params: {
                executable: '/bin/zsh',
                agent: {
                    launchId: 'launch-1',
                    provider: 'codex',
                    executable: '/usr/local/bin/codex',
                    args: ['resume', 'session-1'],
                },
            },
        });

        const identity = {
            scope: 'terminal' as const,
            sessionId: terminal.sessionId,
            terminalId: terminal.id,
            ptyGeneration: 1,
        };
        control.emit({
            type: 'event',
            event: 'terminal.agent.started',
            identity,
            launchId: 'stale-launch',
            processId: 9999,
        });
        expect(execution.agentProcessId(terminal.id)).toBeUndefined();
        control.emit({
            type: 'event',
            event: 'terminal.agent.started',
            identity: { ...identity, ptyGeneration: 2 },
            launchId: 'launch-1',
            processId: 9999,
        });
        expect(execution.agentProcessId(terminal.id)).toBeUndefined();
        control.emit({
            type: 'event',
            event: 'terminal.agent.started',
            identity,
            launchId: 'launch-1',
            processId: 4244,
        });
        expect(execution.agentProcessId(terminal.id)).toBe(4244);
        expect(events).toHaveBeenLastCalledWith({
            type: 'agentStarted',
            terminalId: terminal.id,
            launchId: 'launch-1',
            processId: 4244,
        });

        expect(execution.signalAgentExact(terminal.id, 'stale-launch', 'SIGINT')).toBe(false);
        expect(execution.signalAgentExact(terminal.id, 'launch-1', 'SIGINT')).toBe(true);
        await vi.waitFor(() =>
            expect(control.requests.at(-1)?.request).toEqual({
                method: 'terminal.agent.signal',
                params: { launchId: 'launch-1', signal: 'SIGINT' },
            }),
        );

        control.emit({
            type: 'event',
            event: 'terminal.agent.exit',
            identity,
            launchId: 'stale-launch',
            exitCode: 0,
        });
        expect(execution.agentProcessId(terminal.id)).toBe(4244);
        control.emit({
            type: 'event',
            event: 'terminal.agent.exit',
            identity,
            launchId: 'launch-1',
            exitCode: null,
            signal: 'SIGINT',
        });
        expect(execution.agentProcessId(terminal.id)).toBeUndefined();
        expect(events).toHaveBeenLastCalledWith({
            type: 'agentExit',
            terminalId: terminal.id,
            launchId: 'launch-1',
            exitCode: null,
            signal: 'SIGINT',
        });
    });

    it('retires the managed Agent identity when the root PTY exits', async () => {
        const { control, execution } = createExecution();
        await execution.reserve(terminal);
        await execution.start({
            args: [],
            environment: {},
            executable: '/bin/zsh',
            initialSnapshot: null,
            record: terminal,
            agent: {
                launchId: 'launch-1',
                provider: 'codex',
                executable: '/usr/local/bin/codex',
                args: [],
                environment: {},
            },
        });
        const identity = {
            scope: 'terminal' as const,
            sessionId: terminal.sessionId,
            terminalId: terminal.id,
            ptyGeneration: 1,
        };
        control.emit({
            type: 'event',
            event: 'terminal.agent.started',
            identity,
            launchId: 'launch-1',
            processId: 4244,
        });
        control.emit({
            type: 'event',
            event: 'terminal.exit',
            identity,
            exitCode: 0,
            snapshot,
        });

        expect(execution.agentProcessId(terminal.id)).toBeUndefined();
        expect(execution.signalAgentExact(terminal.id, 'launch-1', 'SIGINT')).toBe(false);
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
            agent: {
                launchId: 'launch-1',
                provider: 'codex',
                executable: '/usr/local/bin/codex',
                args: [],
                environment: {},
            },
        });
        control.emit({
            type: 'event',
            event: 'terminal.agent.started',
            identity: {
                scope: 'terminal',
                sessionId: terminal.sessionId,
                terminalId: terminal.id,
                ptyGeneration: 1,
            },
            launchId: 'launch-1',
            processId: 4244,
        });
        control.exit();

        expect(hostExit).toHaveBeenCalledWith([terminal.id]);
        expect(execution.processId(terminal.id)).toBeUndefined();
        expect(execution.agentProcessId(terminal.id)).toBeUndefined();
        expect(execution.signalAgentExact(terminal.id, 'launch-1', 'SIGINT')).toBe(false);
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

    it('drains oversized public input through surrogate-safe private requests', async () => {
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
        const data = `${'x'.repeat(MAX_TERMINAL_INPUT_LENGTH - 1)}🙂tail`;

        const drained = execution.writeAcknowledged(terminal.id, data);
        await vi.waitFor(() => {
            const inputs = control.requests.filter(
                ({ request }) => request.method === 'terminal.input',
            );
            expect(inputs).toHaveLength(1);
            expect(
                (inputs[0].request as Extract<TerminalHostRequest, { method: 'terminal.input' }>)
                    .params.data,
            ).toBe('x'.repeat(MAX_TERMINAL_INPUT_LENGTH - 1));
        });
        expect(await Promise.race([drained, Promise.resolve('pending')])).toBe('pending');

        control.releaseInput();
        await vi.waitFor(() =>
            expect(
                control.requests.filter(({ request }) => request.method === 'terminal.input'),
            ).toHaveLength(2),
        );
        const inputs = control.requests
            .filter(({ request }) => request.method === 'terminal.input')
            .map(
                ({ request }) =>
                    (request as Extract<TerminalHostRequest, { method: 'terminal.input' }>).params
                        .data,
            );
        expect(inputs[1]).toBe('🙂tail');
        expect(inputs.join('')).toBe(data);
        expect(await Promise.race([drained, Promise.resolve('pending')])).toBe('pending');

        control.releaseInput();
        await expect(drained).resolves.toBe(true);
    });

    it('rejects cancelled or failed delivery receipts and accepts later input', async () => {
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

        const cancellation = new AbortController();
        const cancelled = execution.writeAcknowledged(
            terminal.id,
            'x'.repeat(MAX_TERMINAL_INPUT_LENGTH + 1),
            cancellation.signal,
        );
        await vi.waitFor(() =>
            expect(
                control.requests.filter(({ request }) => request.method === 'terminal.input'),
            ).toHaveLength(1),
        );
        cancellation.abort();
        await expect(cancelled).rejects.toMatchObject({ code: 'CANCELLED' });

        control.holdInputRequests = false;
        control.failNextInput = new Error('seeded input failure');
        await expect(execution.writeAcknowledged(terminal.id, 'failed')).rejects.toThrow(
            'seeded input failure',
        );
        await expect(execution.writeAcknowledged(terminal.id, 'recovered')).resolves.toBe(true);
    });

    it('rejects input declined by an exited private Terminal and accepts later input', async () => {
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

        control.declineNextInput = true;
        await expect(execution.writeAcknowledged(terminal.id, 'declined')).rejects.toMatchObject({
            code: 'UNAVAILABLE',
        });
        await expect(execution.writeAcknowledged(terminal.id, 'recovered')).resolves.toBe(true);
    });

    it('rejects a delivery receipt when the Terminal attachment changes', async () => {
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

        const pending = execution.writeAcknowledged(terminal.id, 'pending');
        await vi.waitFor(() =>
            expect(
                control.requests.filter(({ request }) => request.method === 'terminal.input'),
            ).toHaveLength(1),
        );
        await execution.attach(terminal.id);
        await expect(pending).rejects.toMatchObject({ code: 'CONFLICT' });

        control.holdInputRequests = false;
        await expect(execution.writeAcknowledged(terminal.id, 'recovered')).resolves.toBe(true);
    });

    it('rejects input accepted while Terminal Host shutdown is in progress', async () => {
        const { control, execution } = createExecution();
        const shutdownStarted = Promise.withResolvers<void>();
        const releaseShutdown = Promise.withResolvers<void>();
        vi.spyOn(control, 'shutdown').mockImplementationOnce(async () => {
            shutdownStarted.resolve();
            await releaseShutdown.promise;
            return [snapshot];
        });
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

        const shutdown = execution.shutdown();
        await shutdownStarted.promise;
        const outcome = (async () => {
            try {
                await execution.writeAcknowledged(terminal.id, 'arrived during shutdown');
                return { status: 'resolved' as const };
            } catch (error) {
                return { error, status: 'rejected' as const };
            }
        })();
        await vi.waitFor(() =>
            expect(
                control.requests.filter(({ request }) => request.method === 'terminal.input'),
            ).toHaveLength(1),
        );

        releaseShutdown.resolve();
        await shutdown;
        await expect(
            Promise.race([
                outcome,
                new Promise<{ status: 'pending' }>((resolve) =>
                    setImmediate(() => resolve({ status: 'pending' })),
                ),
            ]),
        ).resolves.toMatchObject({
            error: { code: 'UNAVAILABLE' },
            status: 'rejected',
        });
    });

    it('rejects an oversized public input before sending a private request', async () => {
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
        const requestsBeforeInput = control.requests.length;

        await expect(
            execution.writeAcknowledged(
                terminal.id,
                'x'.repeat(MAX_TERMINAL_INPUT_PAYLOAD_LENGTH + 1),
            ),
        ).resolves.toBe(false);
        expect(control.requests).toHaveLength(requestsBeforeInput);
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
});
