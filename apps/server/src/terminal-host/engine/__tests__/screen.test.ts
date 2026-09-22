import { Terminal } from '@xterm/headless';
import { describe, expect, it } from 'vitest';

import { TerminalOutputFramer } from '../output-framer';
import { TerminalScreenState } from '../screen';

describe('TerminalScreenState', () => {
    it('preserves the live parser boundary when a snapshot splits a cursor command', async () => {
        const source = new TerminalScreenState('', 20, 4);
        const restored = new TerminalScreenState('', 20, 4);
        try {
            const framer = new TerminalOutputFramer();
            for (const frame of framer.push('header\r\nold\u{1B}[2;')) source.write(frame.data);
            const snapshot = await source.snapshot();
            restored.write(snapshot.payload);
            for (const frame of framer.push('1Hupdated')) {
                source.write(frame.data);
                restored.write(frame.data);
            }
            expect(await restored.textTail(200)).toEqual(await source.textTail(200));
        } finally {
            source.dispose();
            restored.dispose();
        }
    });

    it('does not replay hidden alternate-screen columns after shrinking the grid', async () => {
        const source = new TerminalScreenState('', 10, 4);
        const restored = new Terminal({ cols: 5, rows: 4, allowProposedApi: true });
        try {
            source.write('\u{1B}[?1049hABCDEFGHIJ\u{1B}[2;1Hsecond\u{1B}[3;1Hthird\u{1B}[2;3H');
            source.resize(5, 4);
            const snapshot = await source.snapshot();
            await new Promise<void>((resolve) => restored.write(snapshot.payload, resolve));
            expect(
                Array.from({ length: 3 }, (_, row) =>
                    restored.buffer.active.getLine(row)?.translateToString(true),
                ),
            ).toEqual(['ABCDE', 'secon', 'third']);
            expect([restored.buffer.active.cursorX, restored.buffer.active.cursorY]).toEqual([
                2, 1,
            ]);
        } finally {
            source.dispose();
            restored.dispose();
        }
    });

    it.each([
        ['', '\u{1B}[1;10H', ['ABCDEFGHIX', 'Y']],
        ['\u{1B}[?1049h', '\u{1B}[1;10H', ['ABCDEFGHIX', 'Y']],
        ['', '', ['ABCDEFGHIJ', 'XY']],
        ['\u{1B}[?1049h', '', ['ABCDEFGHIJ', 'XY']],
    ])(
        'restores full-width cursor placement and pending wrap (%j, %j)',
        async (mode, cursor, expected) => {
            const source = new TerminalScreenState('', 10, 2);
            const restored = new Terminal({ cols: 10, rows: 2, allowProposedApi: true });
            try {
                source.write(`${mode}ABCDEFGHIJ${cursor}`);
                const snapshot = await source.snapshot();
                await new Promise<void>((resolve) =>
                    restored.write(`${snapshot.payload}XY`, resolve),
                );
                expect(
                    [0, 1].map((row) =>
                        restored.buffer.active.getLine(row)?.translateToString(true),
                    ),
                ).toEqual(expected);
            } finally {
                source.dispose();
                restored.dispose();
            }
        },
    );

    it('uses Unicode 11 widths consistently across CJK, combining, Nerd, and emoji glyphs', async () => {
        const screen = new TerminalScreenState('', 6, 2);

        screen.write('界é🤦X\rZ');
        const snapshot = await screen.snapshot();

        expect(snapshot.payload).toBe('界é🤦Z');
        screen.dispose();
    });

    it('keeps writes and coalesced resizes ordered before a snapshot barrier', async () => {
        const screen = new TerminalScreenState('', 20, 4);

        screen.write('first');
        for (let columns = 21; columns <= 200; columns += 1) screen.resize(columns, 4);
        screen.write('\r\nlatest');
        const snapshot = await screen.snapshot();

        expect(snapshot.payload).toContain('first');
        expect(snapshot.payload).toContain('latest');
        expect(snapshot).toMatchObject({ cols: 200, rows: 4 });
        screen.dispose();
    });

    it('can omit interaction modes from a durable visual snapshot', async () => {
        const screen = new TerminalScreenState('', 20, 4);

        screen.write('\u{1B}[?2004hvisible');
        const liveSnapshot = await screen.snapshot();
        const snapshot = await screen.snapshot({ excludeModes: true });

        expect(liveSnapshot.payload).toContain('\u{1B}[?2004h');
        expect(snapshot.payload).toContain('visible');
        expect(snapshot.payload).not.toContain('\u{1B}[?2004h');
        screen.dispose();
    });

    it('snapshots the current OSC 8 target when the same visible label is replaced', async () => {
        const screen = new TerminalScreenState('', 20, 4);

        screen.write('\u{1B}]8;;https://example.com/stale\u{7}LABEL\u{1B}]8;;\u{7}');
        await screen.snapshot();
        screen.write('\r\u{1B}]8;;https://example.com/authoritative\u{7}LABEL\u{1B}]8;;\u{7}');

        expect((await screen.snapshot()).oscLinks).toMatchObject([
            {
                buffer: 'normal',
                endCellOffset: 5,
                startCellOffset: 0,
                target: 'https://example.com/authoritative',
            },
        ]);
        screen.dispose();
    });

    it('snapshots normal-buffer OSC 8 targets while the alternate buffer is active', async () => {
        const screen = new TerminalScreenState('', 20, 4);

        screen.write(
            '\u{1B}]8;;https://example.com/normal-buffer\u{7}LABEL\u{1B}]8;;\u{7}' +
                '\u{1B}[?1049hALTERNATE',
        );

        const snapshot = await screen.snapshot();
        expect(snapshot.payload).toContain('LABEL');
        expect(snapshot.payload).toContain('\u{1B}[?1049h');
        expect(snapshot.oscLinks).toMatchObject([
            {
                buffer: 'normal',
                endCellOffset: 5,
                startCellOffset: 0,
                target: 'https://example.com/normal-buffer',
            },
        ]);
        screen.dispose();
    });

    it('snapshots OSC 8 targets created in the active alternate buffer', async () => {
        const screen = new TerminalScreenState('', 20, 4);

        screen.write(
            '\u{1B}[?1049h\u{1B}]8;;https://example.com/alternate-buffer\u{7}LABEL\u{1B}]8;;\u{7}',
        );

        const snapshot = await screen.snapshot();
        expect(snapshot.payload).toContain('LABEL');
        expect(snapshot.oscLinks).toMatchObject([
            {
                buffer: 'alternate',
                target: 'https://example.com/alternate-buffer',
            },
        ]);
        screen.dispose();
    });

    it('preserves inactive normal-buffer OSC 8 targets across reflow', async () => {
        const screen = new TerminalScreenState('', 80, 4);
        const target = 'https://example.com/inactive-reflow';

        screen.write(
            `prefix-${'x'.repeat(48)}` +
                `\u{1B}]8;;${target}\u{7}${'LABEL'.repeat(8)}\u{1B}]8;;\u{7}` +
                '\r\n\u{1B}[?1049hALTERNATE',
        );
        expect((await screen.snapshot()).oscLinks).toEqual([
            expect.objectContaining({ buffer: 'normal', target }),
        ]);

        screen.resize(60, 4);

        expect((await screen.snapshot()).oscLinks).toEqual([
            expect.objectContaining({ buffer: 'normal', target }),
        ]);
        screen.dispose();
    });

    it('preserves inactive normal-buffer OSC 8 targets when wrapped rows merge', async () => {
        const screen = new TerminalScreenState('', 20, 4);
        const target = 'https://example.com/inactive-grow';

        screen.write(
            `\u{1B}]8;;${target}\u{7}${'L'.repeat(21)}\u{1B}]8;;\u{7}` +
                '\r\n\u{1B}[?1049hALTERNATE',
        );
        expect((await screen.snapshot()).oscLinks).toEqual([
            expect.objectContaining({ buffer: 'normal', target }),
        ]);

        screen.resize(30, 4);

        expect((await screen.snapshot()).oscLinks).toEqual([
            expect.objectContaining({ buffer: 'normal', target }),
        ]);
        screen.dispose();
    });

    it('omits OSC targets when aggregate snapshot bounds remove their normal-buffer labels', async () => {
        const screen = new TerminalScreenState('', 20, 4);
        const normalLines = Array.from({ length: 1_998 }, (_, index) => `line-${index}`).join(
            '\r\n',
        );

        screen.write(
            `prefix-1\r\n` +
                `\u{1B}]8;;https://secret.example/oldest\u{7}OLDEST-LABEL\u{1B}]8;;\u{7}\r\n${
                    normalLines
                }\u{1B}[?1049hALT-1\r\nALT-2\r\nALT-3\r\nALT-4`,
        );

        const snapshot = await screen.snapshot();
        expect(snapshot.payload).not.toContain('OLDEST-LABEL');
        expect(snapshot.payload).toContain('line-100');
        expect(snapshot.oscLinks ?? []).not.toEqual(
            expect.arrayContaining([
                expect.objectContaining({ target: 'https://secret.example/oldest' }),
            ]),
        );
        screen.dispose();
    });

    it('reads a bounded parsed text tail across ANSI styling, carriage returns, and wrapped rows', async () => {
        const screen = new TerminalScreenState('', 80, 4);

        screen.write('old value\rnew \u{1B}[31mAPI timeout\u{1B}[0m');

        expect(await screen.textTail(100)).toEqual({
            beforeCursorLine: '',
            cursorLine: 'new API timeout',
            full: 'new API timeout',
        });
        expect(await screen.textTail(7)).toEqual({
            beforeCursorLine: '',
            cursorLine: 'new API timeout',
            full: 'timeout',
        });
        screen.dispose();
    });

    it('separates the active cursor line from completed output for Agent status chrome', async () => {
        const screen = new TerminalScreenState('', 100, 4);

        screen.write(
            'API Error: The response stopped arriving. The response above may be incomplete.\r\n' +
                '* Cogitated for 21m 52s',
        );

        expect(await screen.textTail(200)).toEqual({
            beforeCursorLine:
                'API Error: The response stopped arriving. The response above may be incomplete.',
            cursorLine: '* Cogitated for 21m 52s',
            full:
                'API Error: The response stopped arriving. The response above may be incomplete.\n' +
                '* Cogitated for 21m 52s',
        });
        screen.dispose();
    });

    it('separates a Claude Code capacity stop from its active composer prompt', async () => {
        const screen = new TerminalScreenState('', 100, 4);
        const capacityMessage = '⚠ Selected model is at capacity. Please try a different model.';

        screen.write(`\u{1B}[33m${capacityMessage}\u{1B}[0m\r\n❯`);

        expect(await screen.textTail(200)).toEqual({
            beforeCursorLine: capacityMessage,
            cursorLine: '❯',
            full: `${capacityMessage}\n❯`,
        });
        screen.dispose();
    });

    it('bounds parser backlog and makes an overflowed recovery explicit', async () => {
        const overflows: number[] = [];
        const screen = new TerminalScreenState('', 40, 6, {
            maximumQueuedBytes: 64,
            onOverflow: (droppedBytes) => {
                overflows.push(droppedBytes);
            },
        });

        for (let index = 0; index < 100; index += 1) screen.write('12345678');
        expect(screen.pendingByteCount()).toBeLessThanOrEqual(64);

        const snapshot = await screen.snapshot();
        expect(overflows.length).toBeGreaterThan(0);
        expect(snapshot.payload).toContain('exceeded parser backpressure');
        screen.dispose();
    });

    it('resolves a pending snapshot from the explicit reset after parser overflow', async () => {
        const screen = new TerminalScreenState('', 40, 6, { maximumQueuedBytes: 64 });
        screen.write('before-overflow');
        const snapshot = screen.snapshot();
        screen.write('x'.repeat(65));

        expect((await snapshot).payload).toContain('exceeded parser backpressure');
        screen.dispose();
    });
});
