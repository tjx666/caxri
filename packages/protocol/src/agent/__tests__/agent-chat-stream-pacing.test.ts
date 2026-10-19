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
