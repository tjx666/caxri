import type { MobileServerPayload } from '@caxri/mobile-transport';
// oxlint-disable typescript/require-await, typescript/unbound-method -- Async Host mocks and Vitest method assertions have no this binding.
import type { TerminalSnapshot, TerminalWheelInput } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { TerminalExecutionPort } from '../../../../domains/terminal';
import { MobileTerminalObserver } from '../terminal-observer';

const snapshot: TerminalSnapshot = {
    terminalId: 'terminal-1',
    encodingVersion: 1,
    cols: 80,
    rows: 24,
    lineCount: 10,
    byteCount: 60 * 1_024,
    payload: 'x'.repeat(60 * 1_024),
    updatedAt: 1_788_106_000_000,
};

/* eslint-disable no-await-in-loop -- Each cause gets a fresh observer and its own resync assertion. */
describe('MobileTerminalObserver', () => {
    it('sends an ACK-gated snapshot one completed chunk at a time before buffered Host output', async () => {
        const observed = Promise.withResolvers<{
            snapshot: TerminalSnapshot | null;
            nextSequence: number;
            generation: number;
        }>();
        const releaseFirstChunk = Promise.withResolvers<void>();
        const sent: MobileServerPayload[] = [];
        const port = {
            observe: vi.fn(() => observed.promise),
            unobserve: vi.fn(() => Promise.resolve()),
            releaseTakeOver: vi.fn(() => Promise.resolve()),
        } as unknown as TerminalExecutionPort;
        const observer = new MobileTerminalObserver({
            terminalId: 'terminal-1',
            subscriptionId: 'subscription-1',
            holderId: 'connection-1:subscription-1',
            port,
            authorize: () => Promise.resolve(),
            reserve: () => true,
            release: vi.fn(),
            send: async (payload) => {
                sent.push(payload);
                if (sent.length === 1) await releaseFirstChunk.promise;
            },
            remove: vi.fn(),
            terminate: vi.fn(),
        });
        const starting = observer.start();
        observer.accept({
            type: 'output',
            terminalId: 'terminal-1',
            generation: 2,
            sequence: 7,
            data: 'later',
        });
        observed.resolve({ snapshot, nextSequence: 7, generation: 2 });
        await starting;
        expect(sent).toEqual([]);
        observer.activate();
        await vi.waitFor(() => expect(sent).toHaveLength(1));
        observer.accept({
            type: 'output',
            terminalId: 'terminal-1',
            generation: 2,
            sequence: 8,
            data: 'latest',
        });
        expect(sent).toHaveLength(1);
        releaseFirstChunk.resolve();
        await vi.waitFor(() => expect(sent).toHaveLength(5));
        expect(sent.map((frame) => frame.type === 'stream' && frame.kind)).toEqual([
            'terminal.snapshot',
            'terminal.snapshot',
            'terminal.snapshot',
            'terminal.output',
            'terminal.output',
        ]);
        expect(sent.map((frame) => 'sequence' in frame && frame.sequence)).toEqual([0, 1, 2, 3, 4]);
        await observer.close();
        expect(port.unobserve).toHaveBeenCalledWith('terminal-1', 'connection-1:subscription-1');
    });

    it('streams a 2 MiB snapshot without self-overflow and does not repeat it for later output', async () => {
        const sent: MobileServerPayload[] = [];
        const port = {
            observe: vi.fn(async () => ({
                snapshot: { ...snapshot, payload: 'x'.repeat(2 * 1_024 * 1_024) },
                nextSequence: 0,
                generation: 1,
            })),
            unobserve: vi.fn(async () => {}),
        } as unknown as TerminalExecutionPort;
        const observer = new MobileTerminalObserver({
            terminalId: 'terminal-1',
            subscriptionId: 'subscription-1',
            holderId: 'connection-1:subscription-1',
            port,
            authorize: async () => {},
            reserve: () => true,
            release: vi.fn(),
            send: async (payload) => {
                sent.push(payload);
            },
            remove: vi.fn(),
            terminate: vi.fn(),
        });
        await observer.start();
        observer.activate();
        await vi.waitFor(() =>
            expect(
                sent.filter(
                    (frame) => frame.type === 'stream' && frame.kind === 'terminal.snapshot',
                ),
            ).toHaveLength(86),
        );
        observer.accept({
            type: 'output',
            terminalId: 'terminal-1',
            generation: 1,
            sequence: 0,
            data: 'later',
        });
        await vi.waitFor(() => expect(sent).toHaveLength(87));
        expect(
            sent.filter((frame) => frame.type === 'stream' && frame.kind === 'terminal.snapshot'),
        ).toHaveLength(86);
        expect(sent.at(-1)).toMatchObject({
            kind: 'terminal.output',
            hostSequence: 0,
            sequence: 86,
        });
        await observer.close();
    });

    it('resyncs on source gaps and Host exit without waiting for input', async () => {
        for (const cause of ['gap', 'host-exit'] as const) {
            const sent: MobileServerPayload[] = [];
            const remove = vi.fn();
            const port = {
                observe: vi.fn(async () => ({ snapshot: null, nextSequence: 3, generation: 1 })),
                unobserve: vi.fn(async () => {}),
            } as unknown as TerminalExecutionPort;
            const observer = new MobileTerminalObserver({
                terminalId: 'terminal-1',
                subscriptionId: 'subscription-1',
                holderId: 'connection-1:subscription-1',
                port,
                authorize: async () => {},
                reserve: () => true,
                release: vi.fn(),
                send: async (payload) => {
                    sent.push(payload);
                },
                remove,
                terminate: vi.fn(),
            });
            await observer.start();
            observer.activate();
            await vi.waitFor(() => expect(sent).toHaveLength(1));
            if (cause !== 'host-exit')
                observer.accept({
                    type: 'gap',
                    terminalId: 'terminal-1',
                    generation: 1,
                    sequence: 3,
                    reason: 'overflow',
                });
            else observer.invalidate();
            await vi.waitFor(() => expect(sent).toHaveLength(2));
            expect(sent[1]).toMatchObject({
                kind: 'resync-required',
                reason: cause === 'gap' ? 'source-gap' : 'generation-changed',
            });
            await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());
        }
    });

    it('replaces a resized snapshot without closing the mobile lease', async () => {
        const sent: MobileServerPayload[] = [];
        const remove = vi.fn();
        const reportResync = vi.fn();
        const port = {
            observe: vi
                .fn()
                .mockResolvedValueOnce({
                    snapshot: { ...snapshot, payload: 'old', byteCount: 3 },
                    nextSequence: 3,
                    generation: 1,
                })
                .mockResolvedValueOnce({
                    snapshot: { ...snapshot, cols: 100, payload: 'new', byteCount: 3 },
                    nextSequence: 4,
                    generation: 1,
                }),
            unobserve: vi.fn(async () => {}),
            takeOver: vi.fn(async () => ({ expiresAt: 1_000 })),
            releaseTakeOver: vi.fn(async () => {}),
            inputForGeneration: vi.fn(async () => true),
        } as unknown as TerminalExecutionPort;
        const observer = new MobileTerminalObserver({
            terminalId: 'terminal-1',
            subscriptionId: 'subscription-1',
            holderId: 'connection-1:subscription-1',
            port,
            authorize: async () => {},
            reserve: () => true,
            release: vi.fn(),
            send: async (payload) => {
                sent.push(payload);
            },
            remove,
            reportResync,
            terminate: vi.fn(),
        });
        await observer.start();
        observer.activate();
        await vi.waitFor(() => expect(sent).toHaveLength(1));
        await observer.takeOver(1, { cols: 70, rows: 20 });
        observer.accept({
            type: 'gap',
            terminalId: 'terminal-1',
            generation: 1,
            sequence: 3,
            reason: 'resize',
        });
        await vi.waitFor(() => expect(sent).toHaveLength(2));
        expect(sent[1]).toMatchObject({
            kind: 'terminal.snapshot',
            nextHostSequence: 4,
            sequence: 1,
        });
        expect(remove).not.toHaveBeenCalled();
        expect(port.releaseTakeOver).not.toHaveBeenCalled();
        expect(reportResync).toHaveBeenCalledExactlyOnceWith('resize');
        await observer.input(1, 'still controlled');
        expect(port.inputForGeneration).toHaveBeenCalledOnce();
        await observer.close();
        expect(port.releaseTakeOver).toHaveBeenCalledOnce();
    });

    // MOB-HUMAN-STEER-01: mobile-issued Terminal input must be distinguishable from a desktop/CLI principal's in the
    // shared `terminal.human_steer` log event (issue caxri#739), so a successful mobile send reports its terminalId.
    it('reports human steering after a successful mobile input send', async () => {
        const reportHumanSteer = vi.fn();
        const port = {
            observe: vi.fn(async () => ({ snapshot: null, nextSequence: 0, generation: 1 })),
            unobserve: vi.fn(async () => {}),
            inputForGeneration: vi.fn(async () => true),
        } as unknown as TerminalExecutionPort;
        const observer = new MobileTerminalObserver({
            terminalId: 'terminal-1',
            subscriptionId: 'subscription-1',
            holderId: 'connection-1:subscription-1',
            port,
            authorize: async () => {},
            reserve: () => true,
            release: vi.fn(),
            send: async () => {},
            remove: vi.fn(),
            reportHumanSteer,
            terminate: vi.fn(),
        });
        await observer.start();
        await observer.input(1, 'ls -la');
        expect(reportHumanSteer).toHaveBeenCalledExactlyOnceWith('terminal-1');
    });

    it('does not report human steering when the input send fails', async () => {
        const reportHumanSteer = vi.fn();
        const port = {
            observe: vi.fn(async () => ({ snapshot: null, nextSequence: 0, generation: 1 })),
            unobserve: vi.fn(async () => {}),
            inputForGeneration: vi.fn(async () => false),
        } as unknown as TerminalExecutionPort;
        const observer = new MobileTerminalObserver({
            terminalId: 'terminal-1',
            subscriptionId: 'subscription-1',
            holderId: 'connection-1:subscription-1',
            port,
            authorize: async () => {},
            reserve: () => true,
            release: vi.fn(),
            send: async () => {},
            remove: vi.fn(),
            reportHumanSteer,
            terminate: vi.fn(),
        });
        await observer.start();
        await expect(observer.input(1, 'ls -la')).rejects.toThrow('Terminal generation changed');
        expect(reportHumanSteer).not.toHaveBeenCalled();
    });

    it('scrolls without a size lease but only for the current generation', async () => {
        const port = {
            observe: vi.fn(async () => ({ snapshot: null, nextSequence: 0, generation: 2 })),
            unobserve: vi.fn(async () => {}),
            scrollForGeneration: vi.fn(async () => true),
        } as unknown as TerminalExecutionPort;
        const authorize = vi.fn(async () => {});
        const observer = new MobileTerminalObserver({
            terminalId: 'terminal-1',
            subscriptionId: 'subscription-1',
            holderId: 'connection-1:subscription-1',
            port,
            authorize,
            reserve: () => true,
            release: vi.fn(),
            send: async () => {},
            remove: vi.fn(),
            terminate: vi.fn(),
        });
        await observer.start();
        const wheel = { col: 4, lines: -3, row: 9 };
        await observer.scroll(2, wheel);
        expect(authorize).toHaveBeenCalledOnce();
        expect(port.scrollForGeneration).toHaveBeenCalledExactlyOnceWith(
            'terminal-1',
            2,
            wheel,
            expect.any(AbortSignal),
        );
        await expect(observer.scroll(1, wheel)).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(port.scrollForGeneration).toHaveBeenCalledOnce();
        await observer.close();
    });

    // MOB-SCROLL-ABORT-01: a scroll request that outlives its subscription must abort instead of
    // reaching the Terminal Host after the mobile client disconnected or cancelled the request.
    it('aborts a queued Host scroll when its subscription closes before Host admission', async () => {
        const admitted = Promise.withResolvers<void>();
        const releaseHost = Promise.withResolvers<void>();
        const port = {
            observe: vi.fn(async () => ({ snapshot: null, nextSequence: 0, generation: 1 })),
            unobserve: vi.fn(async () => {}),
            scrollForGeneration: vi.fn(
                async (
                    _id: string,
                    _generation: number,
                    _wheel: TerminalWheelInput,
                    signal: AbortSignal,
                ) => {
                    admitted.resolve();
                    await releaseHost.promise;
                    if (signal.aborted) throw new Error('Canceled before Host send');
                    return true;
                },
            ),
        } as unknown as TerminalExecutionPort;
        const observer = new MobileTerminalObserver({
            terminalId: 'terminal-1',
            subscriptionId: 'subscription-1',
            holderId: 'connection-1:subscription-1',
            port,
            authorize: async () => {},
            reserve: () => true,
            release: vi.fn(),
            send: async () => {},
            remove: vi.fn(),
            terminate: vi.fn(),
        });
        await observer.start();
        const wheel = { col: 4, lines: -3, row: 9 };
        const scrolling = observer.scroll(1, wheel);
        await admitted.promise;
        await observer.close();
        releaseHost.resolve();
        await expect(scrolling).rejects.toThrow('Canceled before Host send');
        expect(port.scrollForGeneration).toHaveBeenCalledOnce();
    });

    it('renews an idle lease and releases only its exact holder on close', async () => {
        const port = {
            observe: vi.fn(async () => ({ snapshot: null, nextSequence: 0, generation: 2 })),
            unobserve: vi.fn(async () => {}),
            takeOver: vi.fn(async () => ({ expiresAt: 1_000 })),
            renewTakeOver: vi.fn(async () => ({ expiresAt: 2_000 })),
            releaseTakeOver: vi.fn(async () => {}),
        } as unknown as TerminalExecutionPort;
        const observer = new MobileTerminalObserver({
            terminalId: 'terminal-1',
            subscriptionId: 'subscription-1',
            holderId: 'connection-old:subscription-1',
            port,
            authorize: async () => {},
            reserve: () => true,
            release: vi.fn(),
            send: async () => {},
            remove: vi.fn(),
            terminate: vi.fn(),
        });
        await observer.start();
        await observer.takeOver(2, { cols: 90, rows: 30 });
        await observer.renewLease();
        expect(port.renewTakeOver).toHaveBeenCalledWith(
            'terminal-1',
            'connection-old:subscription-1',
            2,
            12_000,
        );
        await observer.close();
        expect(port.releaseTakeOver).toHaveBeenCalledWith(
            'terminal-1',
            'connection-old:subscription-1',
            2,
        );
        expect(port.releaseTakeOver).not.toHaveBeenCalledWith(
            'terminal-1',
            'connection-new:subscription-1',
            2,
        );
    });

    it('does not retry a rejected resync frame indefinitely', async () => {
        const send = vi.fn(async (payload: MobileServerPayload) => {
            if (payload.type === 'event') throw new Error('Socket send failed');
        });
        const terminate = vi.fn();
        const port = {
            observe: vi.fn(async () => ({ snapshot: null, nextSequence: 0, generation: 1 })),
            unobserve: vi.fn(async () => {}),
        } as unknown as TerminalExecutionPort;
        const observer = new MobileTerminalObserver({
            terminalId: 'terminal-1',
            subscriptionId: 'subscription-1',
            holderId: 'connection-1:subscription-1',
            port,
            authorize: async () => {},
            reserve: () => true,
            release: vi.fn(),
            send,
            remove: vi.fn(),
            terminate,
        });
        await observer.start();
        observer.activate();
        await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
        observer.invalidate();
        await vi.waitFor(() => expect(terminate).toHaveBeenCalledOnce());
        await Promise.resolve();
        expect(send).toHaveBeenCalledTimes(2);
    });

    it('finishes cleanup when Host release and unobserve both reject', async () => {
        const port = {
            observe: vi.fn(async () => ({ snapshot: null, nextSequence: 0, generation: 1 })),
            takeOver: vi.fn(async () => ({ expiresAt: 1_000 })),
            releaseTakeOver: vi.fn(async () => {
                throw new Error('Host unavailable');
            }),
            unobserve: vi.fn(async () => {
                throw new Error('Host unavailable');
            }),
        } as unknown as TerminalExecutionPort;
        const observer = new MobileTerminalObserver({
            terminalId: 'terminal-1',
            subscriptionId: 'subscription-1',
            holderId: 'connection-1:subscription-1',
            port,
            authorize: async () => {},
            reserve: () => true,
            release: vi.fn(),
            send: async () => {},
            remove: vi.fn(),
            terminate: vi.fn(),
        });
        await observer.start();
        await observer.takeOver(1, { cols: 80, rows: 24 });
        await expect(observer.close()).resolves.toBeUndefined();
        expect(port.releaseTakeOver).toHaveBeenCalledOnce();
        expect(port.unobserve).toHaveBeenCalledOnce();
    });

    it('aborts a queued Host input when its subscription closes before Host admission', async () => {
        const admitted = Promise.withResolvers<void>();
        const releaseHost = Promise.withResolvers<void>();
        const port = {
            observe: vi.fn(async () => ({ snapshot: null, nextSequence: 0, generation: 1 })),
            unobserve: vi.fn(async () => {}),
            inputForGeneration: vi.fn(
                async (_id: string, _generation: number, _data: string, signal: AbortSignal) => {
                    admitted.resolve();
                    await releaseHost.promise;
                    if (signal.aborted) throw new Error('Canceled before Host send');
                    return true;
                },
            ),
        } as unknown as TerminalExecutionPort;
        const observer = new MobileTerminalObserver({
            terminalId: 'terminal-1',
            subscriptionId: 'subscription-1',
            holderId: 'connection-1:subscription-1',
            port,
            authorize: async () => {},
            reserve: () => true,
            release: vi.fn(),
            send: async () => {},
            remove: vi.fn(),
            terminate: vi.fn(),
        });
        await observer.start();
        const input = observer.input(1, 'a');
        await admitted.promise;
        await observer.close();
        releaseHost.resolve();
        await expect(input).rejects.toThrow('Canceled before Host send');
        expect(port.inputForGeneration).toHaveBeenCalledOnce();
    });
});
/* eslint-enable no-await-in-loop */
