import { CaxriError, logEventCatalog } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TerminalHostRequest } from '../../../terminal-host/protocol';
import {
    cleanupExecutionFixtures,
    createExecution,
    snapshot,
    terminal,
} from './execution-fixtures';

afterEach(cleanupExecutionFixtures);

/**
 * How `RemoteTerminalExecution` binds a Renderer view to a Terminal: reservation before launch, the window where a
 * re-attachment is accepted but not yet published, and detaching a view that was never reserved. Split out of
 * `./execution.test.ts`, which owns input delivery and PTY generations, when that file passed the 800-line cap.
 */
describe('architecture-a3b-terminal-host: RemoteTerminalExecution view attachment', () => {
    it('rejects a Host observation that has no live snapshot', async () => {
        const { control, execution } = createExecution();
        await execution.reserve(terminal);
        await execution.start({
            args: [],
            environment: {},
            executable: '/bin/zsh',
            initialSnapshot: null,
            record: terminal,
        });
        control.observeReturnsNull = true;
        await expect(execution.observe(terminal.id, 'observer-1')).rejects.toMatchObject({
            code: 'UNAVAILABLE',
        });
    });

    it('passes mobile input cancellation to the Host request', async () => {
        const { control, execution } = createExecution();
        await execution.reserve(terminal);
        await execution.start({
            args: [],
            environment: {},
            executable: '/bin/zsh',
            initialSnapshot: null,
            record: terminal,
        });
        const request = vi.spyOn(control, 'request');
        const cancellation = new AbortController();
        await expect(
            execution.inputForGeneration(terminal.id, 1, '\u{1B}[A', cancellation.signal),
        ).resolves.toBe(true);
        expect(request).toHaveBeenLastCalledWith(
            { method: 'terminal.observer.input', params: { data: '\u{1B}[A' } },
            expect.objectContaining({ capability: 'terminal.mobile.input' }),
            cancellation.signal,
        );
    });

    it('projects observer output without a desktop attachment and fences old generations', async () => {
        const { control, execution } = createExecution();
        const observer = vi.fn();
        const desktop = vi.fn();
        execution.onObserverEvent(observer);
        execution.onEvent(desktop);
        await execution.reserve(terminal);
        await execution.start({
            args: [],
            environment: {},
            executable: '/bin/zsh',
            initialSnapshot: null,
            record: terminal,
        });
        await expect(execution.observe(terminal.id, 'observer-1')).resolves.toEqual({
            snapshot,
            nextSequence: 4,
            generation: 1,
        });
        const identity = {
            scope: 'terminal' as const,
            sessionId: terminal.sessionId,
            terminalId: terminal.id,
            ptyGeneration: 1,
        };
        control.emit({
            type: 'event',
            event: 'terminal.observer.output',
            identity: { ...identity, ptyGeneration: 0 },
            sequence: 4,
            data: 'stale',
        });
        control.emit({
            type: 'event',
            event: 'terminal.observer.output',
            identity,
            sequence: 4,
            data: 'live',
        });
        expect(observer).toHaveBeenCalledOnce();
        expect(observer).toHaveBeenCalledWith({
            type: 'output',
            terminalId: terminal.id,
            generation: 1,
            sequence: 4,
            data: 'live',
        });
        expect(desktop).not.toHaveBeenCalled();
        expect(control.requests.at(-1)).toMatchObject({
            request: { method: 'terminal.observe' },
            scope: { capability: 'terminal.observe', ptyGeneration: 1 },
        });
        await execution.unobserve(terminal.id, 'observer-1');
    });
    it('projects size ownership only for the current PTY generation', async () => {
        const { control, execution } = createExecution();
        const desktop = vi.fn();
        execution.onEvent(desktop);
        await execution.reserve(terminal);
        await execution.start({
            args: [],
            environment: {},
            executable: '/bin/zsh',
            initialSnapshot: null,
            record: terminal,
        });
        const identity = {
            scope: 'terminal' as const,
            sessionId: terminal.sessionId,
            terminalId: terminal.id,
            ptyGeneration: 1,
        };
        control.emit({
            type: 'event',
            event: 'terminal.sizeOwnership',
            identity: { ...identity, ptyGeneration: 0 },
            owner: 'mobile',
            cols: 42,
            rows: 20,
        });
        control.emit({
            type: 'event',
            event: 'terminal.sizeOwnership',
            identity,
            owner: 'mobile',
            cols: 42,
            rows: 20,
        });
        expect(desktop).toHaveBeenCalledOnce();
        expect(desktop).toHaveBeenCalledWith({
            type: 'sizeOwnership',
            terminalId: terminal.id,
            owner: 'mobile',
            cols: 42,
            rows: 20,
        });
    });
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

    /**
     * Re-attaching over a live attachment takes a snapshot of the screen, and the Renderer replays only what arrives
     * after it. Anything forwarded between accepting the re-attachment and rotating the attachment id is therefore
     * already inside the snapshot the Renderer is about to write, and lands on screen twice. A held resize is what
     * makes the window observable here; in production it is `identity.ready` plus the Host's own attach round trip.
     */
    it('stops forwarding live output when it accepts a re-attachment, not when the rotation lands', async () => {
        const { control, execution } = createExecution();
        const output = vi.fn();
        execution.onEvent(output);
        await execution.reserve(terminal);
        await execution.start({
            args: ['-l'],
            environment: { TERM: 'xterm-256color' },
            executable: '/bin/zsh',
            initialSnapshot: null,
            record: terminal,
        });
        await execution.attach(terminal.id, { cols: 120, rows: 40 });
        const attached = control.requests.find(
            ({ request }) => request.method === 'terminal.attach',
        )!.request as Extract<TerminalHostRequest, { method: 'terminal.attach' }>;

        control.holdResizeRequests = true;
        expect(execution.resize(terminal.id, 100, 30)).toBe(true);
        await vi.waitFor(() => expect(control.requestCount('terminal.resize')).toBe(1));
        const reattaching = execution.attach(terminal.id, { cols: 100, rows: 30 });
        // One macrotask is past every microtask in `attach`, so the re-attachment is now parked in `settleHotPaths`.
        await new Promise((resolve) => setTimeout(resolve, 0));
        control.emit({
            type: 'event',
            event: 'terminal.output',
            identity: {
                scope: 'terminal',
                sessionId: terminal.sessionId,
                terminalId: terminal.id,
                ptyGeneration: 1,
                attachmentId: attached.params.attachmentId,
            },
            data: 'already inside the snapshot',
        });
        control.releaseResize();
        await reattaching;

        expect(output).not.toHaveBeenCalled();
    });

    it('drains hot paths admitted while changing the Terminal attachment', async () => {
        const { control, execution } = createExecution();
        control.holdInputRequests = true;
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
        const pending = execution.writeAcknowledged(terminal.id, 'pending');
        await vi.waitFor(() => expect(control.requestCount('terminal.input')).toBe(1));
        expect(execution.resize(terminal.id, 120, 40)).toBe(true);
        await vi.waitFor(() => expect(control.requestCount('terminal.resize')).toBe(1));
        const reattachment = execution.attach(terminal.id);
        await Promise.resolve();
        expect(control.requestCount('terminal.attach')).toBe(1);
        control.releaseInput();
        await expect(pending).resolves.toBe(true);
        const duringReattachment = execution.writeAcknowledged(terminal.id, 'during');
        await vi.waitFor(() => expect(control.requestCount('terminal.input')).toBe(2));
        control.releaseResize();
        expect(
            await Promise.race([
                reattachment,
                new Promise<'pending'>((resolve) => setTimeout(resolve, 0, 'pending')),
            ]),
        ).toBe('pending');
        control.releaseInput();
        await expect(duringReattachment).resolves.toBe(true);
        await expect(reattachment).resolves.toMatchObject({ snapshot: null });
        expect(control.requestCount('terminal.attach')).toBe(2);
    });

    it('forwards no output between accepting a re-attach and publishing its attachment', async () => {
        const { control, execution } = createExecution();
        const output = vi.fn();
        execution.onEvent((event) => {
            if (event.type === 'output') output(event.data);
        });
        await execution.attach(terminal.id);
        await execution.reserve(terminal);
        await execution.start({
            args: [],
            environment: {},
            executable: '/bin/zsh',
            initialSnapshot: null,
            record: terminal,
        });
        const attachmentIdOf = (index: number): string => {
            const attach = control.requests.filter(
                ({ request }) => request.method === 'terminal.attach',
            )[index].request as Extract<TerminalHostRequest, { method: 'terminal.attach' }>;
            return attach.params.attachmentId;
        };
        const flush = (data: string, attachmentId = attachmentIdOf(0)): void =>
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
                data,
            });

        flush('settled');
        expect(output.mock.calls.flat()).toEqual(['settled']);

        /**
         * A held input parks the re-attach inside `settleHotPaths`, which is the widest await between accepting the
         * re-attach and publishing its `attachmentId` — the window issue #740 is about. The Renderer has already
         * installed its replacement replay buffer by then, so anything forwarded here is replayed _after_ the snapshot
         * this same re-attach returns.
         */
        control.holdInputRequests = true;
        expect(execution.write(terminal.id, 'typed')).toBe(true);
        await vi.waitFor(() => expect(control.requestCount('terminal.input')).toBe(1));
        control.attachSnapshot = { ...snapshot, payload: 'settled/flushed' };
        const reattachment = execution.attach(terminal.id);
        await Promise.resolve();
        expect(control.requestCount('terminal.attach')).toBe(1);

        // Terminal Host wrote this batch to the live screen before its 16 ms timer shipped it, so the snapshot has it too.
        flush('flushed');
        control.releaseInput();

        expect((await reattachment).snapshot?.payload).toContain('flushed');
        expect(output.mock.calls.flat()).toEqual(['settled']);

        // The mute lasts exactly as long as the gap; the published attachment forwards again.
        flush('after', attachmentIdOf(1));
        expect(output.mock.calls.flat()).toEqual(['settled', 'after']);
    });

    it('does not start an empty Terminal Host to detach an unreserved view', async () => {
        const { control, execution } = createExecution();
        await execution.attach(terminal.id);

        execution.detachAllViews();

        expect(control.requests).toEqual([]);
    });

    /**
     * Terminal Host keeps its previous attachment when it rejects `terminal.attach`, so every frame it emits afterwards
     * still carries the attachment it accepted last. Core has to forward under that id again, or the Terminal stays
     * muted until the next re-attach happens to succeed (#910, #938).
     */
    describe('rejected re-attach', () => {
        async function attachedTerminal(): Promise<{
            control: ReturnType<typeof createExecution>['control'];
            execution: ReturnType<typeof createExecution>['execution'];
            logger: ReturnType<typeof createExecution>['logger'];
            output: ReturnType<typeof vi.fn>;
            attachmentIdOf: (index: number) => string;
            flush: (data: string, attachmentId: string) => void;
        }> {
            const { control, execution, logger } = createExecution();
            const output = vi.fn();
            execution.onEvent((event) => {
                if (event.type === 'output') output(event.data);
            });
            await execution.reserve(terminal);
            await execution.start({
                args: [],
                environment: {},
                executable: '/bin/zsh',
                initialSnapshot: null,
                record: terminal,
            });
            await execution.attach(terminal.id, { cols: 120, rows: 40 });
            const attachmentIdOf = (index: number): string => {
                const attach = control.requests.filter(
                    ({ request }) => request.method === 'terminal.attach',
                )[index].request as Extract<TerminalHostRequest, { method: 'terminal.attach' }>;
                return attach.params.attachmentId;
            };
            const flush = (data: string, attachmentId: string): void =>
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
                    data,
                });
            return { control, execution, logger, output, attachmentIdOf, flush };
        }

        it('keeps forwarding live output under the attachment Terminal Host still holds', async () => {
            const { control, execution, logger, output, attachmentIdOf, flush } =
                await attachedTerminal();
            const writeLog = vi.spyOn(logger, 'write');
            flush('before', attachmentIdOf(0));

            // `UNAVAILABLE` is raised before the frame reaches the host, so the host provably kept the first id.
            const rejection = new CaxriError('UNAVAILABLE', 'Terminal Host is unavailable');
            control.failNextAttach = rejection;
            await expect(execution.attach(terminal.id, { cols: 100, rows: 30 })).rejects.toBe(
                rejection,
            );

            // The host never accepted the second attachment, so its output keeps the first id.
            flush('after', attachmentIdOf(0));
            flush('never', attachmentIdOf(1));
            expect(output.mock.calls.flat()).toEqual(['before', 'after']);
            expect(execution.write(terminal.id, 'typed')).toBe(true);
            await vi.waitFor(() => expect(control.requestCount('terminal.input')).toBe(1));
            expect(control.requests.at(-1)?.scope).toMatchObject({
                attachmentId: attachmentIdOf(0),
            });
            const attachFailed = writeLog.mock.calls.find(
                ([, event]) => event === logEventCatalog.terminalHost.attachFailed,
            );
            expect(attachFailed?.[0]).toBe('warn');
            expect(attachFailed?.[2]).toMatchObject({
                fields: { terminalId: terminal.id, errorCode: 'UNAVAILABLE', rolledBack: true },
                failure: { reason: 'terminal-host-exited', phase: 'attach' },
            });
        });

        it('keeps the requested attachment when the host may already have adopted it', async () => {
            const { control, execution, logger, output, attachmentIdOf, flush } =
                await attachedTerminal();
            const writeLog = vi.spyOn(logger, 'write');

            // A timed-out frame is still in the channel: the host adopts the requested id once it gets to it, and
            // only the late reply is dropped. Rolling back here would mute the frames the host emits under it.
            control.failNextAttach = new CaxriError('TIMEOUT', 'Terminal Host request timed out');
            await expect(execution.attach(terminal.id)).rejects.toMatchObject({ code: 'TIMEOUT' });

            flush('stale', attachmentIdOf(0));
            flush('adopted', attachmentIdOf(1));
            expect(output.mock.calls.flat()).toEqual(['adopted']);
            expect(execution.write(terminal.id, 'typed')).toBe(true);
            await vi.waitFor(() => expect(control.requestCount('terminal.input')).toBe(1));
            expect(control.requests.at(-1)?.scope).toMatchObject({
                attachmentId: attachmentIdOf(1),
            });
            const attachFailed = writeLog.mock.calls.find(
                ([, event]) => event === logEventCatalog.terminalHost.attachFailed,
            );
            expect(attachFailed?.[2]).toMatchObject({
                fields: { errorCode: 'TIMEOUT', rolledBack: false, hadAttachment: true },
                failure: { reason: 'timeout' },
            });
        });

        it.each([false, true])(
            'restores one current view after an ambiguous timeout (adopted=%s)',
            async (adopted) => {
                const { control, execution, output, attachmentIdOf, flush } =
                    await attachedTerminal();
                control.failNextAttach = new CaxriError('TIMEOUT', 'Synthetic attachment timeout');
                await expect(execution.attach(terminal.id)).rejects.toMatchObject({
                    code: 'TIMEOUT',
                });
                flush('during-timeout', attachmentIdOf(adopted ? 1 : 0));
                expect(output.mock.calls.flat()).toEqual(adopted ? ['during-timeout'] : []);

                control.attachSnapshot = snapshot;
                await expect(execution.attach(terminal.id)).resolves.toMatchObject({ snapshot });
                output.mockClear();
                flush('original-stale', attachmentIdOf(0));
                flush('timed-out-stale', attachmentIdOf(1));
                flush('current', attachmentIdOf(2));
                expect(output.mock.calls.flat()).toEqual(['current']);
                expect(execution.write(terminal.id, 'typed')).toBe(true);
                await vi.waitFor(() => expect(control.requestCount('terminal.input')).toBe(1));
                expect(control.requests.at(-1)?.scope).toMatchObject({
                    attachmentId: attachmentIdOf(2),
                });
                expect(control.requestCount('terminal.start')).toBe(1);
            },
        );

        it('classifies the host refusing a stale scope instead of logging it as unknown', async () => {
            const { control, execution, logger, output, attachmentIdOf, flush } =
                await attachedTerminal();
            const writeLog = vi.spyOn(logger, 'write');

            // The host's authorization refusal is a plain Error with a code outside the protocol's `errorCodes`,
            // exactly what `replyError` in the supervisor produces; it runs before dispatch touches the attachment.
            control.failNextAttach = Object.assign(
                new Error('Terminal Host request was not authorized'),
                {
                    code: 'CAPABILITY_DENIED',
                },
            );
            await expect(execution.attach(terminal.id)).rejects.toMatchObject({
                code: 'CAPABILITY_DENIED',
            });

            flush('kept', attachmentIdOf(0));
            flush('refused', attachmentIdOf(1));
            expect(output.mock.calls.flat()).toEqual(['kept']);
            const attachFailed = writeLog.mock.calls.find(
                ([, event]) => event === logEventCatalog.terminalHost.attachFailed,
            );
            expect(attachFailed?.[2]).toMatchObject({
                fields: { errorCode: 'CAPABILITY_DENIED', rolledBack: true },
                failure: { code: 'CAPABILITY_DENIED', reason: 'generation-superseded' },
            });
        });

        it('lets the next re-attach succeed and rotate the forwarded attachment', async () => {
            const { control, execution, output, attachmentIdOf, flush } = await attachedTerminal();
            control.failNextAttach = new CaxriError('UNAVAILABLE', 'Terminal Host is unavailable');
            await expect(execution.attach(terminal.id)).rejects.toMatchObject({
                code: 'UNAVAILABLE',
            });

            control.attachSnapshot = snapshot;
            await expect(execution.attach(terminal.id)).resolves.toMatchObject({ snapshot });

            flush('stale', attachmentIdOf(0));
            flush('current', attachmentIdOf(2));
            expect(output.mock.calls.flat()).toEqual(['current']);
        });

        it('does not roll back over a newer re-attach that overlapped the rejected one', async () => {
            const { control, execution, output, attachmentIdOf, flush } = await attachedTerminal();
            control.holdAttachRequests = true;
            const first = execution.attach(terminal.id);
            await vi.waitFor(() => expect(control.requestCount('terminal.attach')).toBe(2));
            const second = execution.attach(terminal.id);
            await vi.waitFor(() => expect(control.requestCount('terminal.attach')).toBe(3));

            control.releaseAttach(new CaxriError('TIMEOUT', 'Terminal Host request timed out'));
            await expect(first).rejects.toMatchObject({ code: 'TIMEOUT' });
            control.releaseAttach();
            await expect(second).resolves.toMatchObject({ snapshot: null });

            flush('original', attachmentIdOf(0));
            flush('rejected', attachmentIdOf(1));
            flush('newest', attachmentIdOf(2));
            expect(output.mock.calls.flat()).toEqual(['newest']);
        });

        it('falls back to the attachment the host confirmed when two overlapping attaches are both refused', async () => {
            const { control, execution, output, attachmentIdOf, flush } = await attachedTerminal();
            control.holdAttachRequests = true;
            const first = execution.attach(terminal.id);
            await vi.waitFor(() => expect(control.requestCount('terminal.attach')).toBe(2));
            const second = execution.attach(terminal.id);
            await vi.waitFor(() => expect(control.requestCount('terminal.attach')).toBe(3));

            // Neither view reached the host, so the host still holds the first attachment, not the first rejected one.
            control.releaseAttach(new CaxriError('UNAVAILABLE', 'Terminal Host is unavailable'));
            await expect(first).rejects.toMatchObject({ code: 'UNAVAILABLE' });
            control.releaseAttach(new CaxriError('UNAVAILABLE', 'Terminal Host is unavailable'));
            await expect(second).rejects.toMatchObject({ code: 'UNAVAILABLE' });

            flush('held', attachmentIdOf(0));
            flush('first', attachmentIdOf(1));
            flush('second', attachmentIdOf(2));
            expect(output.mock.calls.flat()).toEqual(['held']);
            expect(execution.write(terminal.id, 'typed')).toBe(true);
            await vi.waitFor(() => expect(control.requestCount('terminal.input')).toBe(1));
            expect(control.requests.at(-1)?.scope).toMatchObject({
                attachmentId: attachmentIdOf(0),
            });
        });

        it('leaves a view alone when a reserve replaced the identity that asked for it', async () => {
            const { control, execution, output, attachmentIdOf } = await attachedTerminal();
            control.holdAttachRequests = true;
            const stale = execution.attach(terminal.id);
            await vi.waitFor(() => expect(control.requestCount('terminal.attach')).toBe(2));

            // A restart reserves a new generation, whose own re-attach of the same view is the one the host confirms.
            const reserved = execution.reserve(terminal);
            await vi.waitFor(() => expect(control.requestCount('terminal.attach')).toBe(3));
            control.releaseAttach(
                Object.assign(new Error('Terminal Host request was not authorized'), {
                    code: 'CAPABILITY_DENIED',
                }),
            );
            await expect(stale).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
            control.releaseAttach();
            await reserved;

            /**
             * The host now emits under the reserved generation, and the view it confirmed is still the gate.
             */
            const emit = (data: string, attachmentId: string): void =>
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
                    data,
                });
            emit('original', attachmentIdOf(0));
            emit('current', attachmentIdOf(1));
            expect(output.mock.calls.flat()).toEqual(['current']);
            execution.detachView(terminal.id);
            await vi.waitFor(() => expect(control.requestCount('terminal.detach')).toBe(1));
        });

        it('rolls a never-attached view back to nothing instead of a phantom attachment', async () => {
            const { control, execution } = createExecution();
            await execution.reserve(terminal);
            await execution.start({
                args: [],
                environment: {},
                executable: '/bin/zsh',
                initialSnapshot: null,
                record: terminal,
            });
            control.failNextAttach = new CaxriError(
                'CAPACITY',
                'Terminal Host request capacity exceeded',
            );
            await expect(execution.attach(terminal.id)).rejects.toMatchObject({ code: 'CAPACITY' });

            // Nothing is attached, so resize and input have no view or attachment to bind to.
            expect(execution.resize(terminal.id, 80, 24)).toBe(false);
            expect(execution.write(terminal.id, 'typed')).toBe(false);
            execution.detachView(terminal.id);
            expect(control.requestCount('terminal.detach')).toBe(0);
        });
    });
});
