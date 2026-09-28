import { MAX_TERMINAL_INPUT_LENGTH, MAX_TERMINAL_INPUT_PAYLOAD_LENGTH } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TerminalHostRequest } from '../../../terminal-host/protocol';
import type { RemoteTerminalExecution } from '../execution';
import {
    cleanupExecutionFixtures,
    createExecution,
    snapshot,
    startBackgroundAgent,
    terminal,
} from './execution-fixtures';

afterEach(cleanupExecutionFixtures);

function generationCount(execution: RemoteTerminalExecution): number {
    return (execution as unknown as { generations: Map<string, number> }).generations.size;
}

/**
 * Input delivery, PTY generations, and shutdown. The view-attachment half of the same class lives in
 * `./execution-attachment.test.ts`; the two were one file until it outgrew the 800-line cap.
 */
describe('architecture-a3b-terminal-host: RemoteTerminalExecution', () => {
    it('releases generations after 200 permanently closed Terminals and shutdown', async () => {
        const { control, execution } = createExecution();
        for (let index = 0; index < 200; index += 1) {
            const record = { ...terminal, id: `terminal-${index}` };
            // eslint-disable-next-line no-await-in-loop -- each Terminal is fully started before permanent closure
            await execution.reserve(record);
            // eslint-disable-next-line no-await-in-loop -- each Terminal is fully started before permanent closure
            await execution.start({
                args: [],
                environment: {},
                executable: '/bin/zsh',
                initialSnapshot: null,
                record,
            });
            execution.close(record.id);
        }
        expect(generationCount(execution)).toBe(0);
        await vi.waitFor(() => expect(control.requestCount('terminal.retire')).toBe(200));
        expect(control.requestCount('terminal.stop')).toBe(0);

        await execution.reserve(terminal);
        await execution.start({
            args: [],
            environment: {},
            executable: '/bin/zsh',
            initialSnapshot: null,
            record: terminal,
        });
        expect(generationCount(execution)).toBe(1);
        await execution.shutdown();
        expect(generationCount(execution)).toBe(0);
    });

    it('keeps the next generation after a failed launch discards a reusable Terminal', async () => {
        const { control, execution } = createExecution();
        await execution.reserve(terminal);
        await execution.start({
            args: [],
            environment: {},
            executable: '/bin/zsh',
            initialSnapshot: null,
            record: terminal,
        });
        execution.discard(terminal.id);
        expect(generationCount(execution)).toBe(1);
        await execution.reserve(terminal);
        const reserve = control.requests.findLast(
            ({ request }) => request.method === 'terminal.reserve',
        )!;
        expect(reserve.scope).toMatchObject({ ptyGeneration: 2 });
    });

    it('does not restore a closed generation when an in-flight Host start completes', async () => {
        const { control, execution } = createExecution();
        const originalRequest = control.request.bind(control);
        const pendingStart = Promise.withResolvers<unknown>();
        const request = vi
            .spyOn(control, 'request')
            .mockImplementation((message, scope, signal) =>
                message.method === 'terminal.start'
                    ? pendingStart.promise
                    : originalRequest(message, scope, signal),
            );
        await execution.reserve(terminal);
        const starting = execution.start({
            args: [],
            environment: {},
            executable: '/bin/zsh',
            initialSnapshot: null,
            record: terminal,
        });
        await vi.waitFor(() =>
            expect(
                request.mock.calls.some(([message]) => message.method === 'terminal.start'),
            ).toBe(true),
        );
        execution.close(terminal.id);
        pendingStart.resolve({ processId: 4243 });
        await starting;
        expect(generationCount(execution)).toBe(0);
    });

    it('accepts exact Agent input for a live background Terminal without a Renderer attachment', async () => {
        const { control, execution } = createExecution();
        await execution.reserve(terminal);
        await execution.start({
            args: ['-l'],
            environment: { TERM: 'xterm-256color' },
            executable: '/bin/zsh',
            initialSnapshot: null,
            record: terminal,
            agent: {
                launchId: 'launch-1',
                provider: 'claude',
                executable: '/usr/local/bin/claude',
                args: ['--resume', 'session-1'],
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

        expect(execution.writeAgentExact(terminal.id, 'stale', 'old-launch')).toBe(false);
        expect(execution.writeAgentExact(terminal.id, 'follow-up\r', 'launch-1')).toBe(true);
        await vi.waitFor(() =>
            expect(control.requests.at(-1)?.request).toEqual({
                method: 'terminal.agent.input',
                params: { data: 'follow-up\r', launchId: 'launch-1' },
            }),
        );
        expect(control.requests.at(-1)?.scope).not.toHaveProperty('attachmentId');
        expect(execution.writeAgentExact(terminal.id, '\u{1B}', 'launch-1')).toBe(true);
        await vi.waitFor(() =>
            expect(control.requests.at(-1)?.request).toEqual({
                method: 'terminal.agent.input',
                params: { data: '\u{1B}', launchId: 'launch-1' },
            }),
        );
    });

    /**
     * The synchronous `true` above only means the input was admitted for delivery: without an attachment the write
     * travels to the Terminal Host, which can still refuse it or fail outright. A caller that treats that admission as
     * proof records a submission the Agent never received (github.com/tjx666/caxri/issues/893).
     */
    it('reports what the Host did with a background Agent input the caller was told was accepted', async () => {
        const { control, execution } = createExecution();
        await startBackgroundAgent(execution, control);
        const delivered = vi.fn();

        control.declineNextAgentInput = true;
        expect(execution.writeAgentExact(terminal.id, 'refused\r', 'launch-1', delivered)).toBe(
            true,
        );
        await vi.waitFor(() => expect(delivered).toHaveBeenLastCalledWith(false));

        control.failNextAgentInput = new Error('Synthetic Host failure');
        expect(execution.writeAgentExact(terminal.id, '\u{1B}', 'launch-1', delivered)).toBe(true);
        await vi.waitFor(() => expect(delivered).toHaveBeenCalledTimes(2));
        expect(delivered).toHaveBeenLastCalledWith(false);

        expect(execution.writeAgentExact(terminal.id, 'accepted\r', 'launch-1', delivered)).toBe(
            true,
        );
        await vi.waitFor(() => expect(delivered).toHaveBeenLastCalledWith(true));
    });

    it('projects only the current managed Agent launch and signals it by exact identity', async () => {
        const { control, execution } = createExecution();
        const events = vi.fn();
        execution.onEvent(events);
        await execution.reserve(terminal);
        await execution.attach(terminal.id, { cols: 100, rows: 30 });
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
        expect(execution.agentLaunchId(terminal.id)).toBe('launch-1');
        expect(events).toHaveBeenLastCalledWith({
            type: 'agentStarted',
            terminalId: terminal.id,
            launchId: 'launch-1',
            processId: 4244,
        });

        expect(execution.writeAgentExact(terminal.id, 'stale', 'stale-launch')).toBe(false);
        const delivered = vi.fn();
        expect(execution.writeAgentExact(terminal.id, 'summary', 'launch-1', delivered)).toBe(true);
        await vi.waitFor(() =>
            expect(control.requests.at(-1)?.request).toEqual({
                method: 'terminal.input',
                params: { data: 'summary', expectedAgentLaunchId: 'launch-1' },
            }),
        );

        await vi.waitFor(() => expect(delivered).toHaveBeenCalledExactlyOnceWith(true));
        control.holdAgentInputRequests = true;
        const reply = execution.writeAgent(terminal.id, 'Continue\r');
        await vi.waitFor(() =>
            expect(control.requests.at(-1)?.request).toEqual({
                method: 'terminal.agent.input',
                params: { data: 'Continue\r', launchId: 'launch-1' },
            }),
        );
        expect(control.requests.at(-1)?.scope).toMatchObject({
            capability: 'terminal.agent.input',
            terminalId: terminal.id,
        });
        expect(control.requests.at(-1)?.scope).not.toHaveProperty('attachmentId');
        const pending = Symbol('pending Agent input');
        await expect(Promise.race([reply, Promise.resolve(pending)])).resolves.toBe(pending);
        control.releaseAgentInput();
        await expect(reply).resolves.toBe(true);

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
        expect(execution.agentLaunchId(terminal.id)).toBeUndefined();
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

    it('rejects input accepted while Terminal Host shutdown is in progress', async () => {
        const { control, execution } = createExecution();
        const shutdownStarted = Promise.withResolvers<void>();
        const releaseShutdown = Promise.withResolvers<void>();
        vi.spyOn(control, 'shutdown').mockImplementationOnce(async () => {
            shutdownStarted.resolve();
            await releaseShutdown.promise;
            return { failures: [], snapshots: [snapshot] };
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
        expect(control.requestCount('terminal.retire')).toBe(0);

        control.releaseInput();
        await vi.waitFor(() =>
            expect(control.requests.at(-1)!.request.method).toBe('terminal.retire'),
        );
    });
});
