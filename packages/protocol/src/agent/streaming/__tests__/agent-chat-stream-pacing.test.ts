import { describe, expect, it } from 'vitest';

import { createAgentChatStreamPacer } from '../agent-chat-stream-pacing';

/**
 * Runs the pacer at 60 frames per second until it catches up, returning how many characters each frame showed.
 */
const reveal = (
    pacer: ReturnType<typeof createAgentChatStreamPacer>,
    target: string,
    start = 0,
) => {
    const lengths: number[] = [];
    for (let frame = 0; frame < 600; frame += 1) {
        const shown = pacer.next(target, start + frame * 16);
        lengths.push(shown.length);
        if (shown === target) break;
    }
    return lengths;
};

describe('createAgentChatStreamPacer', () => {
    it('shows the first character on the first frame', () => {
        expect(createAgentChatStreamPacer().next('Hello', 0)).toBe('H');
    });

    it('eases a burst in over a few frames and catches up within the drain window', () => {
        const lengths = reveal(createAgentChatStreamPacer('Intro. '), `Intro. ${'x'.repeat(300)}`);
        expect(lengths[0]).toBeGreaterThan(7);
        expect(lengths[0]).toBeLessThan(307);
        expect(lengths.length).toBeLessThan(60);
        for (let index = 1; index < lengths.length; index += 1)
            expect(lengths[index]).toBeGreaterThanOrEqual(lengths[index - 1]);
    });

    it('starts the next burst from a nominal frame after a pause', () => {
        const pacer = createAgentChatStreamPacer();
        reveal(pacer, 'First.');
        // Ten seconds later a long burst arrives; the first frame must not reveal it all.
        const next = pacer.next(`First.${'y'.repeat(400)}`, 10_000).length;
        expect(next).toBeLessThan(100);
    });

    it('keeps typing through bursts a mobile network clumps together', () => {
        // A phone on a cellular link receives a steady 60 characters a second as one 24-character clump every 400ms,
        // and redraws every 32ms. The reveal should spread each clump over the gap instead of draining it and stalling.
        const pacer = createAgentChatStreamPacer();
        const clump = 24;
        const gapMs = 400;
        let idle = 0;
        let counted = 0;
        let largestStep = 0;
        let previous = 0;
        for (let now = 0; now < 20 * gapMs; now += 32) {
            const arrived = Math.floor(now / gapMs) + 1;
            const shown = pacer.next('x'.repeat(arrived * clump), now).length;
            // The first clumps teach the pacer the cadence.
            if (now >= 3 * gapMs) {
                counted += 1;
                if (shown === previous) idle += 1;
                largestStep = Math.max(largestStep, shown - previous);
            }
            previous = shown;
        }
        expect(idle / counted).toBeLessThan(0.1);
        // 60 characters a second is about 2 per 32ms redraw; a clump must not pour out in a few redraws.
        expect(largestStep).toBeLessThanOrEqual(6);
    });

    it('stays close behind a steady local stream', () => {
        const pacer = createAgentChatStreamPacer();
        let target = '';
        let shown = '';
        for (let now = 0; now < 4_000; now += 16) {
            target += 'ab';
            shown = pacer.next(target, now);
        }
        // About 125 characters a second; Desktop's local stream should trail by well under half a second.
        expect(target.length - shown.length).toBeLessThan(40);
    });

    it('still eases in a paragraph that lands at once after a steady stream', () => {
        const pacer = createAgentChatStreamPacer();
        let target = '';
        let now = 0;
        for (; now < 1_000; now += 16) {
            target += 'ab';
            pacer.next(target, now);
        }
        const before = pacer.next(target, now).length;
        target += 'z'.repeat(600);
        now += 16;
        const shown = pacer.next(target, now).length;
        expect(shown - before).toBeLessThan(100);
    });

    it('shows a rewound or edited reply whole at once', () => {
        const pacer = createAgentChatStreamPacer('Old reply text');
        expect(pacer.next('New', 0)).toBe('New');
    });

    it('never splits a surrogate pair', () => {
        const pacer = createAgentChatStreamPacer();
        const target = `${'😀'.repeat(40)}`;
        let shown = '';
        for (let frame = 0; shown !== target; frame += 1) {
            shown = pacer.next(target, frame * 16);
            expect(shown.length % 2).toBe(0);
        }
    });
});
