import { describe, expect, it } from 'vitest';

import { TerminalOutputQueue } from '../buffer';
import {
    TERMINAL_IMAGE_OUTPUT_TRUNCATED_PLACEHOLDER,
    TERMINAL_IMAGE_RECOVERY_PLACEHOLDER,
    TerminalImageOutputFilter,
    TerminalImageRecoveryFilter,
} from '../image-recovery';

describe('TerminalImageRecoveryFilter', () => {
    it('redacts chunked IIP payloads and preserves later text', () => {
        const filter = new TerminalImageRecoveryFilter();

        expect(filter.push('before\x1b]1337;Fi')).toBe('before');
        const output = filter.push('le=inline=1:PNG_SECRET\x07after');

        expect(output).toBe(`${TERMINAL_IMAGE_RECOVERY_PLACEHOLDER}after`);
        expect(output).not.toContain('PNG_SECRET');
    });

    it('redacts SIXEL and unsupported Kitty payloads', () => {
        const filter = new TerminalImageRecoveryFilter();

        const output = filter.push('a\x1bP1;2qSIXEL_SECRET\x1b\\b\x1b_Gf=100;KITTY_SECRET\x1b\\c');

        expect(output).toBe(
            `a${TERMINAL_IMAGE_RECOVERY_PLACEHOLDER}b${TERMINAL_IMAGE_RECOVERY_PLACEHOLDER}c`,
        );
        expect(output).not.toMatch(/SIXEL_SECRET|KITTY_SECRET/);
    });

    it('redacts multipart IIP and C1 image controls', () => {
        const filter = new TerminalImageRecoveryFilter();

        const output = filter.push(
            '\x1b]1337;MultipartFile=inline=1\x07' +
                '\x1b]1337;FilePart=MULTIPART_SECRET\x1b\\' +
                '\x90qC1_SIXEL_SECRET\x9c' +
                '\x9fGC1_KITTY_SECRET\x9cafter',
        );

        expect(output).toBe(`${TERMINAL_IMAGE_RECOVERY_PLACEHOLDER.repeat(4)}after`);
        expect(output).not.toMatch(/MULTIPART_SECRET|C1_SIXEL_SECRET|C1_KITTY_SECRET/);
    });

    it('leaves non-image OSC and DCS sequences unchanged', () => {
        const filter = new TerminalImageRecoveryFilter();
        const source = '\x1b]0;Window title\x07\x1bP1;2pORDINARY_DCS\x1b\\text';

        expect(filter.push(source)).toBe(source);
        expect(filter.finish()).toBe('');
    });

    it('bounds an oversized image and emits exactly one placeholder', () => {
        const filter = new TerminalImageRecoveryFilter(8);

        const first = filter.push('\x1b]1337;File=x:123456789');
        const second = filter.push('MORE_SECRET\x1b\\after');

        expect(first).toBe(TERMINAL_IMAGE_RECOVERY_PLACEHOLDER);
        expect(second).toBe('after');
        expect(`${first}${second}`).not.toContain('SECRET');
    });

    it('bounds a malformed DCS header instead of retaining it indefinitely', () => {
        const filter = new TerminalImageRecoveryFilter();
        const oversizedHeader = `\x1bP${'1;'.repeat(40)}`;

        expect(filter.push(oversizedHeader)).toBe('');
        expect(filter.push('SECRET\x1b\\after')).toBe(
            `${TERMINAL_IMAGE_RECOVERY_PLACEHOLDER}after`,
        );
    });

    it('turns an incomplete image at process exit into a placeholder', () => {
        const filter = new TerminalImageRecoveryFilter();
        expect(filter.push('\x1bPqUNFINISHED_SECRET')).toBe('');

        expect(filter.finish()).toBe(TERMINAL_IMAGE_RECOVERY_PLACEHOLDER);
    });
});

describe('TerminalImageOutputFilter', () => {
    it.each([
        ['IIP', '\x1b]1337;File=inline=1:SECRET\x07'],
        ['C1 SIXEL', '\x90qSECRET\x9c'],
        ['multipart IIP', '\x1b]1337;FilePart=SECRET\x1b\\'],
    ])('delivers a chunked %s control atomically', (_name, sequence) => {
        const filter = new TerminalImageOutputFilter();
        const output = new TerminalOutputQueue(128);
        const split = Math.floor(sequence.length / 2);

        expect(filter.push(`before${sequence.slice(0, split)}`, output)).toBe(0);
        expect(output.drain()).toBe('before');
        expect(filter.push(`${sequence.slice(split)}after`, output)).toBe(0);
        expect(output.drain()).toBe(`${sequence}after`);
    });

    it.each([
        ['IIP', '\x1b]1337;File=inline=1:SECRET\x07'],
        ['C1 SIXEL', '\x90qSECRET\x9c'],
        ['multipart IIP', '\x1b]1337;FilePart=SECRET\x1b\\'],
    ])(
        'drops a complete %s control rather than truncating it at backpressure',
        (_name, sequence) => {
            const filter = new TerminalImageOutputFilter();
            const output = new TerminalOutputQueue(32);
            expect(output.appendBounded('x'.repeat(24))).toBe(0);

            const droppedBytes = filter.push(`${sequence}after`, output);

            expect(droppedBytes).toBe(Buffer.byteLength(sequence));
            expect(output.drain()).toBe(`${'x'.repeat(24)}after`);
        },
    );

    it('discards an oversized control through its terminator and reports one honest placeholder instead of raw dropped bytes', () => {
        const filter = new TerminalImageOutputFilter(16);
        const output = new TerminalOutputQueue(128);

        const firstBackpressure = filter.push('\x1b]1337;File=inline=1:TOO_LARGE', output);
        const secondBackpressure = filter.push('_SECRET\x1b\\after', output);

        /** The oversized image itself never counts as backpressure: only genuine `destination`
         *  capacity refusals would, and this queue has plenty of room for the small placeholder. */
        expect(firstBackpressure).toBe(0);
        expect(secondBackpressure).toBe(0);
        expect(output.drain()).toBe(`${TERMINAL_IMAGE_OUTPUT_TRUNCATED_PLACEHOLDER}after`);
    });

    describe('finish', () => {
        it('discards a still-buffered sequence silently when no destination is given', () => {
            const filter = new TerminalImageOutputFilter();
            filter.push('\x1b]1337;File=inline=1:UNFINISHED', new TerminalOutputQueue(128));

            expect(filter.finish()).toBe(0);
        });

        it('replaces a still-capturing sequence with the placeholder when a destination is given', () => {
            const filter = new TerminalImageOutputFilter();
            const output = new TerminalOutputQueue(128);
            filter.push('\x1b]1337;File=inline=1:UNFINISHED', output);

            expect(filter.finish(output)).toBe(0);
            expect(output.drain()).toBe(TERMINAL_IMAGE_OUTPUT_TRUNCATED_PLACEHOLDER);
        });

        it('reports nothing when nothing was mid-capture', () => {
            const filter = new TerminalImageOutputFilter();
            const output = new TerminalOutputQueue(128);
            filter.push('plain text', output);
            output.drain();

            expect(filter.finish(output)).toBe(0);
            expect(output.drain()).toBe('');
        });
    });
});
