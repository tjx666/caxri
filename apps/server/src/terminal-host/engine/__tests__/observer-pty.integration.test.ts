import process from 'node:process';

import type { TerminalRecord } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import * as pty from 'node-pty';
import { describe, expect, it, vi } from 'vitest';

import type { TerminalExecutionEvent } from '../engine';
import { TerminalExecutionEngine } from '../engine';

const fixtureProgram = String.raw`// 用固定输出验证真实 PTY 的多观察者流
process.stdin.setEncoding('utf8');
let count = 0;
process.stdin.on('data', () => process.stdout.write('fixture-output-' + ++count + '\r\n'));
`;

describe('Terminal Host real PTY observers', () => {
    it('streams to mobile observers with and without a desktop attachment', async () => {
        const events: TerminalExecutionEvent[] = [];
        const exits: Array<Promise<void>> = [];
        const engine = new TerminalExecutionEngine({
            emit: (event) => events.push(event),
            logger: { write: vi.fn(), recordMetric: vi.fn() } as unknown as StructuredLogger,
            onExit: vi.fn(),
            outputFlushMs: 1,
            spawn: (file, arguments_, options) => {
                const child = pty.spawn(file, arguments_, options);
                exits.push(new Promise((resolve) => child.onExit(() => resolve())));
                return child;
            },
        });
        const record: TerminalRecord = {
            id: 'terminal-fixture',
            sessionId: 'session-fixture',
            cwd: process.cwd(),
            kind: 'shell',
            title: 'Fixture',
            orderIndex: 0,
            lastProcessState: 'running',
            createdAt: 1,
            updatedAt: 1,
        };
        engine.start({
            record,
            args: ['-e', fixtureProgram],
            environment: { TERM: 'xterm-256color' },
            executable: process.execPath,
            initialSnapshot: '',
            initialSize: { cols: 80, rows: 24 },
        });
        try {
            const first = await engine.observe(record.id, 'first');
            const second = await engine.observe(record.id, 'second');
            expect(second.nextSequence).toBe(first.nextSequence);
            engine.write(record.id, 'one\r');
            await expect
                .poll(() =>
                    events
                        .filter((event) => event.type === 'observerOutput')
                        .map((event) => event.data)
                        .join(''),
                )
                .toContain('fixture-output-1');
            expect(events.filter((event) => event.type === 'output')).toEqual([]);

            await engine.attach(record.id, { cols: 80, rows: 24 });
            engine.write(record.id, 'two\r');
            await expect
                .poll(() =>
                    events
                        .filter((event) => event.type === 'output')
                        .map((event) => event.data)
                        .join(''),
                )
                .toContain('fixture-output-2');
            engine.detachView(record.id);
            engine.write(record.id, 'three\r');
            await expect
                .poll(() =>
                    events
                        .filter((event) => event.type === 'observerOutput')
                        .map((event) => event.data)
                        .join(''),
                )
                .toContain('fixture-output-3');
            expect(events.filter((event) => event.type === 'observerGap')).toEqual([]);
        } finally {
            await Promise.all(engine.shutdown().map(({ capture }) => capture));
            await Promise.all(exits);
        }
    });
});
