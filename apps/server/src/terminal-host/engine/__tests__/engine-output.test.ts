import type { TerminalRecord } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import type { IPty } from 'node-pty';
import { describe, expect, it, vi } from 'vitest';

import type { TerminalExecutionEvent } from '../engine';
import { TerminalExecutionEngine } from '../engine';
import { TERMINAL_IMAGE_OUTPUT_TRUNCATED_PLACEHOLDER } from '../image-recovery';
import { TerminalScreenState } from '../screen';

function fixture() {
    let send: (data: string) => void = () => {};
    const events: TerminalExecutionEvent[] = [];
    const engine = new TerminalExecutionEngine({
        emit: (event) => events.push(event),
        logger: { write: vi.fn(), recordMetric: vi.fn() } as unknown as StructuredLogger,
        onExit: vi.fn(),
        outputFlushMs: 1,
        spawn: () =>
            ({
                pid: 999_999,
                onData: (handler: (data: string) => void) => {
                    send = handler;
                },
                onExit: vi.fn(),
                resize: vi.fn(),
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
    return { engine, events, send: (data: string) => send(data) };
}

describe('Terminal execution output boundaries', () => {
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
