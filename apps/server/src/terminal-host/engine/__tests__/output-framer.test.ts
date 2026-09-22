import { describe, expect, it } from 'vitest';

import { TerminalOutputQueue } from '../buffer';
import {
    TERMINAL_IMAGE_RECOVERY_PLACEHOLDER,
    TerminalImageOutputFilter,
    TerminalImageRecoveryFilter,
} from '../image-recovery';
import { TerminalOutputFramer } from '../output-framer';

const sequences = [
    '\u{1B}[2;1H',
    '\u{9B}2;1H',
    '\u{1B}(B',
    '\u{1B}]0;title\u{7}',
    '\u{1B}]8;;https://example.com\u{1B}\\',
    '\u{9D}0;title\u{9C}',
    '\u{1B}P$qm\u{1B}\\',
    '\u{90}$qm\u{9C}',
    '\u{1B}_Gpayload\u{1B}\\',
    '\u{1B}Xignored\u{1B}\\',
    '\u{1B}^ignored\u{1B}\\',
    '\u{9F}Gpayload\u{9C}',
];

describe('TerminalOutputFramer', () => {
    it.each(sequences)('holds every split of control %j until its boundary', (sequence) => {
        for (let split = 1; split < sequence.length; split += 1) {
            const framer = new TerminalOutputFramer();
            expect(framer.push(`before${sequence.slice(0, split)}`)).toEqual([
                { data: 'before', isControl: false },
            ]);
            expect(framer.push(`${sequence.slice(split)}界after`)).toEqual([
                { data: sequence, isControl: true },
                { data: '界after', isControl: false },
            ]);
        }
    });
    it.each(['\u{18}', '\u{1A}'])('preserves an explicit cancellation %j', (cancel) => {
        const framer = new TerminalOutputFramer();
        expect(framer.push(`\u{1B}[123${cancel}visible`)).toEqual([
            { data: `\u{1B}[123${cancel}`, isControl: true },
            { data: 'visible', isControl: false },
        ]);
    });
    it('discards an oversized control through its terminator without exposing its suffix', () => {
        const framer = new TerminalOutputFramer(16);
        expect(framer.push(`\u{1B}]0;${'x'.repeat(30)}`)).toEqual([]);
        expect(framer.push('more')).toEqual([]);
        const frames = framer.push('\u{7}visible');
        expect(frames[0].data).toContain('oversized Terminal control sequence');
        expect(frames[1]).toEqual({ data: 'visible', isControl: false });
        expect(frames.map((frame) => frame.data).join('')).not.toContain('more');
    });
    it('keeps image recovery and live delivery policies on the same completed frame', () => {
        const framer = new TerminalOutputFramer();
        const sequence = '\u{1B}]1337;File=inline=1:fixture\u{7}';
        const recovery = new TerminalImageRecoveryFilter();
        const output = new TerminalImageOutputFilter();
        const queue = new TerminalOutputQueue(1_024);
        expect(framer.push(sequence.slice(0, -1))).toEqual([]);
        const [frame] = framer.push(sequence.slice(-1));
        expect(recovery.push(frame.data)).toBe(TERMINAL_IMAGE_RECOVERY_PLACEHOLDER);
        expect(output.push(frame.data, queue)).toBe(0);
        expect(queue.drain()).toBe(sequence);
    });
});
