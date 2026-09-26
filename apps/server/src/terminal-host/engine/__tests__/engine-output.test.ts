import type { TerminalRecord } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import type { IPty } from 'node-pty';
import { describe, expect, it, vi } from 'vitest';

import type { TerminalExecutionEvent } from '../engine';
import { TerminalExecutionEngine } from '../engine';
import { TERMINAL_IMAGE_OUTPUT_TRUNCATED_PLACEHOLDER } from '../image-recovery';
import { TerminalScreenState } from '../screen';

function fixture(
    options: {
        observerOutputMaximumBytes?: number;
        outputFlushMs?: number;
        screenMaximumQueuedBytes?: number;
    } = {},
) {
    let send: (data: string) => void = () => {};
    const events: TerminalExecutionEvent[] = [];
    let cols = 20;
    let rows = 4;
    const resize = vi.fn((nextCols: number, nextRows: number) => {
        cols = nextCols;
        rows = nextRows;
    });
    const engine = new TerminalExecutionEngine({
        emit: (event) => events.push(event),
        logger: { write: vi.fn(), recordMetric: vi.fn() } as unknown as StructuredLogger,
        onExit: vi.fn(),
        outputFlushMs: options.outputFlushMs ?? 1,
        ...(options.observerOutputMaximumBytes && {
            observerOutputMaximumBytes: options.observerOutputMaximumBytes,
        }),
        ...(options.screenMaximumQueuedBytes && {
            screenMaximumQueuedBytes: options.screenMaximumQueuedBytes,
        }),
        spawn: () =>
            ({
                pid: 999_999,
                get cols() {
                    return cols;
                },
                get rows() {
                    return rows;
                },
                onData: (handler: (data: string) => void) => {
                    send = handler;
                },
                onExit: vi.fn(),
                resize,
                write: vi.fn(),
                kill: vi.fn(),
            }) as unknown as IPty,
    });
    const record: TerminalRecord = {
        id: 'terminal',
        sessionId: 'session',
        cwd: '/project',
        kind: 'shell',
        title: 'Shell',
        icon: 'terminal',
        orderIndex: 0,
        lastProcessState: 'running',
        createdAt: 1,
        updatedAt: 1,
    };
    engine.start({
        record,
        args: [],
        environment: {},
        executable: 'fixture',
        initialSnapshot: '',
        initialSize: { cols: 20, rows: 4 },
    });
    return {
        engine,
        events,
        resize,
        size: () => ({ cols, rows }),
        send: (data: string) => send(data),
    };
}

describe('Terminal execution output boundaries', () => {
    it('rejects a new observer after the PTY has retired', async () => {
        const { engine } = fixture();
        engine.discard('terminal');
        await expect(engine.observe('terminal', 'observer-1')).rejects.toMatchObject({
            code: 'UNAVAILABLE',
        });
    });

    it('lets a mobile observer receive a snapshot and live output without taking the desktop attachment', async () => {
        const { engine, events, send } = fixture();
        try {
            send('before\r\n');
            const observed = await engine.observe('terminal', 'observer-1');
            expect(observed.snapshot?.payload).toContain('before');
            send('after\r\n');
            await expect
                .poll(() => events.filter((event) => event.type === 'observerOutput').length)
                .toBe(1);
            expect(events.filter((event) => event.type === 'output')).toEqual([]);
            expect(events.find((event) => event.type === 'observerOutput')).toMatchObject({
                terminalId: 'terminal',
                data: 'after\r\n',
                sequence: observed.nextSequence,
            });
            const desktop = await engine.attach('terminal', { cols: 20, rows: 4 });
            expect(desktop.wasAttached).toBe(false);
            engine.detachView('terminal');
            send('still-observed\r\n');
            await expect
                .poll(() => events.filter((event) => event.type === 'observerOutput').length)
                .toBe(2);
        } finally {
            await Promise.all(engine.shutdown().map(({ capture }) => capture));
        }
    });
    it('preserves framed observer output across a desktop reattach and detach', async () => {
        const { engine, events, send } = fixture({ outputFlushMs: 50 });
        try {
            await engine.attach('terminal');
            const observed = await engine.observe('terminal', 'observer-1');
            send('before\u{1B}[2;');
            await engine.attach('terminal');
            engine.detachView('terminal');
            send('1Hafter');
            await expect
                .poll(() => events.filter((event) => event.type === 'observerOutput').length)
                .toBe(2);
            const output = events.filter((event) => event.type === 'observerOutput');
            expect(output.map((event) => event.data).join('')).toBe('before\u{1B}[2;1Hafter');
            expect(output.map((event) => event.sequence)).toEqual([
                observed.nextSequence,
                observed.nextSequence + 1,
            ]);
        } finally {
            await Promise.all(engine.shutdown().map(({ capture }) => capture));
        }
    });
    it.each(['reattach', 'detach'] as const)(
        'flushes the last pending observer batch when desktop performs %s',
        async (action) => {
            const { engine, events, send } = fixture({ outputFlushMs: 50 });
            try {
                await engine.attach('terminal');
                await engine.observe('terminal', 'observer-1');
                send('pending-with-no-follow-up');
                if (action === 'reattach') await engine.attach('terminal');
                else engine.detachView('terminal');
                expect(events.filter((event) => event.type === 'observerOutput')).toMatchObject([
                    { data: 'pending-with-no-follow-up' },
                ]);
            } finally {
                await Promise.all(engine.shutdown().map(({ capture }) => capture));
            }
        },
    );
    it('does not replay a pending output batch into an observer that joined after its snapshot waterline', async () => {
        const { engine, events, send } = fixture({ outputFlushMs: 50 });
        try {
            await engine.observe('terminal', 'observer-1');
            send('before\r\n');
            const second = await engine.observe('terminal', 'observer-2');
            expect(second.snapshot?.payload).toContain('before');
            send('after\r\n');
            await expect
                .poll(() => events.filter((event) => event.type === 'observerOutput').length)
                .toBe(2);
            expect(events.filter((event) => event.type === 'observerOutput')).toMatchObject([
                { sequence: second.nextSequence - 1, data: 'before\r\n' },
                { sequence: second.nextSequence, data: 'after\r\n' },
            ]);
        } finally {
            await Promise.all(engine.shutdown().map(({ capture }) => capture));
        }
    });
    it('isolates observer queue overflow from the desktop output queue', async () => {
        const { engine, events, send } = fixture({ observerOutputMaximumBytes: 8 });
        try {
            await engine.attach('terminal');
            await engine.observe('terminal', 'observer-1');
            send('desktop-still-sees-this');
            await expect
                .poll(() => events.filter((event) => event.type === 'observerGap').length)
                .toBe(1);
            await expect
                .poll(() => events.filter((event) => event.type === 'output').length)
                .toBe(1);
            expect(events.find((event) => event.type === 'output')).toMatchObject({
                data: 'desktop-still-sees-this',
            });
        } finally {
            await Promise.all(engine.shutdown().map(({ capture }) => capture));
        }
    });
    it('lets a new observer resume after a gap while the stale observer remains registered', async () => {
        const { engine, events, send } = fixture({ observerOutputMaximumBytes: 8 });
        try {
            await engine.observe('terminal', 'stale-observer');
            send('far-too-long');
            await expect
                .poll(() => events.filter((event) => event.type === 'observerGap').length)
                .toBe(1);
            const fresh = await engine.observe('terminal', 'fresh-observer');
            send('ok');
            await expect
                .poll(() => events.filter((event) => event.type === 'observerOutput').length)
                .toBe(1);
            expect(events.find((event) => event.type === 'observerOutput')).toMatchObject({
                sequence: fresh.nextSequence,
                data: 'ok',
            });
        } finally {
            await Promise.all(engine.shutdown().map(({ capture }) => capture));
        }
    });
    it('emits an observer gap when screen parser backpressure resets recovery', async () => {
        const { engine, events, send } = fixture({ screenMaximumQueuedBytes: 16 });
        try {
            const observed = await engine.observe('terminal', 'observer-1');
            send('a'.repeat(32));
            await expect
                .poll(() => events.filter((event) => event.type === 'observerGap').length)
                .toBe(1);
            expect(events.find((event) => event.type === 'observerGap')).toMatchObject({
                sequence: observed.nextSequence,
            });
        } finally {
            await Promise.all(engine.shutdown().map(({ capture }) => capture));
        }
    });
    it('restores the latest desktop size after an exclusive mobile size lease', async () => {
        const { engine, resize, size } = fixture();
        try {
            await engine.attach('terminal', { cols: 80, rows: 24 });
            engine.takeOver('terminal', 'connection:subscription', { cols: 42, rows: 20 }, 12_000);
            expect(size()).toEqual({ cols: 42, rows: 20 });
            expect(() =>
                engine.takeOver('terminal', 'other:subscription', { cols: 30, rows: 15 }, 12_000),
            ).toThrow();
            engine.resize('terminal', 100, 30);
            await engine.attach('terminal', { cols: 110, rows: 32 });
            expect(size()).toEqual({ cols: 42, rows: 20 });
            engine.releaseTakeOver('terminal', 'connection:subscription');
            expect(size()).toEqual({ cols: 110, rows: 32 });
            expect(resize).toHaveBeenCalledTimes(3);
        } finally {
            await Promise.all(engine.shutdown().map(({ capture }) => capture));
        }
    });
    it('reports current size ownership on takeover, late attach, mobile resize, and release', async () => {
        const { engine, events } = fixture();
        try {
            await engine.attach('terminal', { cols: 80, rows: 24 });
            engine.takeOver('terminal', 'connection:subscription', { cols: 42, rows: 20 }, 12_000);
            engine.resize('terminal', 100, 30);
            await engine.attach('terminal', { cols: 110, rows: 32 });
            engine.takeOver('terminal', 'connection:subscription', { cols: 50, rows: 22 }, 12_000);
            engine.releaseTakeOver('terminal', 'other:subscription');
            engine.releaseTakeOver('terminal', 'connection:subscription');

            expect(events.filter((event) => event.type === 'sizeOwnership')).toEqual([
                {
                    type: 'sizeOwnership',
                    terminalId: 'terminal',
                    owner: 'desktop',
                    cols: 80,
                    rows: 24,
                },
                {
                    type: 'sizeOwnership',
                    terminalId: 'terminal',
                    owner: 'mobile',
                    cols: 42,
                    rows: 20,
                },
                {
                    type: 'sizeOwnership',
                    terminalId: 'terminal',
                    owner: 'mobile',
                    cols: 42,
                    rows: 20,
                },
                {
                    type: 'sizeOwnership',
                    terminalId: 'terminal',
                    owner: 'mobile',
                    cols: 50,
                    rows: 22,
                },
                {
                    type: 'sizeOwnership',
                    terminalId: 'terminal',
                    owner: 'desktop',
                    cols: 110,
                    rows: 32,
                },
            ]);
        } finally {
            await Promise.all(engine.shutdown().map(({ capture }) => capture));
        }
    });
    it('restores the pre-lease size when desktop detaches and the lease expires', async () => {
        vi.useFakeTimers();
        const { engine, events, size } = fixture();
        try {
            await engine.attach('terminal', { cols: 80, rows: 24 });
            engine.takeOver('terminal', 'connection:subscription', { cols: 42, rows: 20 }, 1_000);
            engine.detachView('terminal');
            await vi.advanceTimersByTimeAsync(1_000);
            expect(size()).toEqual({ cols: 80, rows: 24 });
            expect(events.findLast((event) => event.type === 'sizeOwnership')).toEqual({
                type: 'sizeOwnership',
                terminalId: 'terminal',
                owner: 'desktop',
                cols: 80,
                rows: 24,
            });
        } finally {
            await Promise.all(engine.shutdown().map(({ capture }) => capture));
            vi.useRealTimers();
        }
    });
    it.each([32, 70 * 1024])(
        'finishes an attached incomplete image of %i bytes once on exit',
        async (size) => {
            const { engine, events, send } = fixture();
            await engine.attach('terminal');
            send(`\u{1B}]1337;File=inline=1:${'x'.repeat(size)}`);
            await Promise.all(engine.shutdown().map(({ capture }) => capture));
            const output = events.filter((event) => event.type === 'output');
            expect(output).toHaveLength(1);
            expect(output[0]).toMatchObject({
                data: TERMINAL_IMAGE_OUTPUT_TRUNCATED_PLACEHOLDER,
            });
            expect(output[0].droppedBytes ?? 0).toBe(0);
        },
    );
    it('never live-delivers an incomplete cursor control on exit', async () => {
        const { engine, events, send } = fixture();
        await engine.attach('terminal');
        send('\u{1B}[2;');
        await Promise.all(engine.shutdown().map(({ capture }) => capture));
        expect(events.filter((event) => event.type === 'output')).toEqual([]);
    });
    it('finishes an oversized unterminated control with a content-free notice', async () => {
        const { engine, events, send } = fixture();
        await engine.attach('terminal');
        send(`\u{1B}]0;${'x'.repeat(130 * 1024)}`);
        await Promise.all(engine.shutdown().map(({ capture }) => capture));
        const output = events.filter((event) => event.type === 'output');
        expect(output).toHaveLength(1);
        expect(output[0].droppedBytes ?? 0).toBe(0);
        expect(output[0].data).toContain('oversized Terminal control sequence');
        expect(output[0].data).not.toContain('\u{1B}');
    });
    it('keeps unfinished output local when no Renderer is attached', async () => {
        const { engine, events, send } = fixture();
        send('\u{1B}]1337;File=inline=1:fixture');
        await Promise.all(engine.shutdown().map(({ capture }) => capture));
        expect(events.filter((event) => event.type === 'output')).toEqual([]);
    });
    it('reattaches between PTY chunks without replaying a partial cursor sequence', async () => {
        const { engine, events, send } = fixture();
        const restored = new TerminalScreenState('', 20, 4);
        try {
            send('header\r\nold\u{1B}[2;');
            const { snapshot } = await engine.attach('terminal');
            restored.write(snapshot!.payload);
            send('1Hupdated');
            await expect
                .poll(() => events.filter((event) => event.type === 'output').length)
                .toBe(1);
            for (const event of events) if (event.type === 'output') restored.write(event.data);
            expect((await restored.textTail(200)).full).toBe('header\nupdated');
        } finally {
            restored.dispose();
            await Promise.all(engine.shutdown().map(({ capture }) => capture));
        }
    });
    it('drops a control atomically when the live delivery queue runs out of room', async () => {
        const { engine, events, send } = fixture();
        try {
            await engine.attach('terminal');
            send(`${'x'.repeat(256 * 1024 - 2)}\u{1B}[2;1Htail`);
            await expect
                .poll(() => events.filter((event) => event.type === 'output').length)
                .toBe(1);
            const output = events.find((event) => event.type === 'output');
            expect(output).toMatchObject({ droppedBytes: 8 });
            if (output?.type !== 'output') throw new Error('Output was not emitted');
            expect(output.data).not.toContain('\u{1B}');
        } finally {
            await Promise.all(engine.shutdown().map(({ capture }) => capture));
        }
    });
});
