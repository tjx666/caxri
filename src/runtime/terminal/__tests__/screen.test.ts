import { describe, expect, it } from 'vitest';

import { TerminalScreenState } from '../screen';

describe('TerminalScreenState', () => {
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
