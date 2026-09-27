import { Buffer } from 'node:buffer';

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

        expect(filter.push('before\u{1B}]1337;Fi')).toBe('before');
        const output = filter.push('le=inline=1:PNG_SECRET\u{7}after');

        expect(output).toBe(`${TERMINAL_IMAGE_RECOVERY_PLACEHOLDER}after`);
        expect(output).not.toContain('PNG_SECRET');
    });

    it('redacts SIXEL and placed Kitty payloads', () => {
        const filter = new TerminalImageRecoveryFilter();

        const output = filter.push(
            'a\u{1B}P1;2qSIXEL_SECRET\u{1B}\\b\u{1B}_Ga=T,f=100;KITTY_SECRET\u{1B}\\c',
        );

        expect(output).toBe(
            `a${TERMINAL_IMAGE_RECOVERY_PLACEHOLDER}b${TERMINAL_IMAGE_RECOVERY_PLACEHOLDER}c`,
        );
        expect(output).not.toMatch(/SIXEL_SECRET|KITTY_SECRET/);
    });

    it('drops Kitty graphics controls that never place an image without a placeholder', () => {
        const filter = new TerminalImageRecoveryFilter();

        /**
         * Claude Code sends this capability probe at startup in terminals it does not recognize.
         */
        const query = '\u{1B}_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\u{1B}\\';
        const transmitOnly = '\u{1B}_Gi=7,f=100;TRANSMIT_SECRET\u{1B}\\';
        const deletion = '\u{1B}_Ga=d,d=I,i=7,q=2\u{1B}\\';

        const output = filter.push(`before${query}${transmitOnly}${deletion}after`);

        expect(output).toBe('beforeafter');
        expect(filter.finish()).toBe('');
    });

    it('emits one placeholder for a chunked Kitty image placement', () => {
        const filter = new TerminalImageRecoveryFilter();

        const output = filter.push(
            'a\u{1B}_Ga=T,f=100,m=1;FIRST_SECRET\u{1B}\\' +
                '\u{1B}_Gm=1;MIDDLE_SECRET\u{1B}\\' +
                '\u{1B}_Gm=0;LAST_SECRET\u{1B}\\b' +
                '\u{1B}_Ga=p,i=7\u{1B}\\c',
        );

        expect(output).toBe(
            `a${TERMINAL_IMAGE_RECOVERY_PLACEHOLDER}b${TERMINAL_IMAGE_RECOVERY_PLACEHOLDER}c`,
        );
    });

    it('decides Kitty visibility from a header split across chunks', () => {
        const filter = new TerminalImageRecoveryFilter();

        expect(filter.push('before\u{1B}_Gi=31,a')).toBe('before');
        expect(filter.push('=q;AAAA\u{1B}\\after')).toBe('after');
        expect(filter.push('\u{1B}_Ga')).toBe('');
        expect(filter.push('=T;SECRET\u{1B}\\done')).toBe(
            `${TERMINAL_IMAGE_RECOVERY_PLACEHOLDER}done`,
        );
    });

    it('redacts multipart IIP and C1 image controls', () => {
        const filter = new TerminalImageRecoveryFilter();

        const output = filter.push(
            '\u{1B}]1337;MultipartFile=inline=1\u{7}' +
                '\u{1B}]1337;FilePart=MULTIPART_SECRET\u{1B}\\' +
                '\u{90}qC1_SIXEL_SECRET\u{9C}' +
                '\u{9F}Ga=T;C1_KITTY_SECRET\u{9C}after',
        );

        expect(output).toBe(`${TERMINAL_IMAGE_RECOVERY_PLACEHOLDER.repeat(4)}after`);
        expect(output).not.toMatch(/MULTIPART_SECRET|C1_SIXEL_SECRET|C1_KITTY_SECRET/);
    });

    it('leaves non-image OSC and DCS sequences unchanged', () => {
        const filter = new TerminalImageRecoveryFilter();
        const source = '\u{1B}]0;Window title\u{7}\u{1B}P1;2pORDINARY_DCS\u{1B}\\text';

        expect(filter.push(source)).toBe(source);
        expect(filter.finish()).toBe('');
    });

    it('bounds an oversized image and emits exactly one placeholder', () => {
        const filter = new TerminalImageRecoveryFilter(8);

        const first = filter.push('\u{1B}]1337;File=x:123456789');
        const second = filter.push('MORE_SECRET\u{1B}\\after');

        expect(first).toBe(TERMINAL_IMAGE_RECOVERY_PLACEHOLDER);
        expect(second).toBe('after');
        expect(`${first}${second}`).not.toContain('SECRET');
    });

    it('bounds a malformed DCS header instead of retaining it indefinitely', () => {
        const filter = new TerminalImageRecoveryFilter();
        const oversizedHeader = `\u{1B}P${'1;'.repeat(40)}`;

        expect(filter.push(oversizedHeader)).toBe('');
        expect(filter.push('SECRET\u{1B}\\after')).toBe(
            `${TERMINAL_IMAGE_RECOVERY_PLACEHOLDER}after`,
        );
    });

    it('turns an incomplete image at process exit into a placeholder', () => {
        const filter = new TerminalImageRecoveryFilter();
        expect(filter.push('\u{1B}PqUNFINISHED_SECRET')).toBe('');

        expect(filter.finish()).toBe(TERMINAL_IMAGE_RECOVERY_PLACEHOLDER);
    });
});

describe('TerminalImageOutputFilter', () => {
    it.each([
        ['IIP', '\u{1B}]1337;File=inline=1:SECRET\u{7}'],
        ['C1 SIXEL', '\u{90}qSECRET\u{9C}'],
        ['multipart IIP', '\u{1B}]1337;FilePart=SECRET\u{1B}\\'],
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
        ['IIP', '\u{1B}]1337;File=inline=1:SECRET\u{7}'],
        ['C1 SIXEL', '\u{90}qSECRET\u{9C}'],
        ['multipart IIP', '\u{1B}]1337;FilePart=SECRET\u{1B}\\'],
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

        const firstBackpressure = filter.push('\u{1B}]1337;File=inline=1:TOO_LARGE', output);
        const secondBackpressure = filter.push('_SECRET\u{1B}\\after', output);

        /**
         * The oversized image itself never counts as backpressure: only genuine `destination` capacity refusals would,
         * and this queue has plenty of room for the small placeholder.
         */
        expect(firstBackpressure).toBe(0);
        expect(secondBackpressure).toBe(0);
        expect(output.drain()).toBe(`${TERMINAL_IMAGE_OUTPUT_TRUNCATED_PLACEHOLDER}after`);
    });

    describe('finish', () => {
        it('discards a still-buffered sequence silently when no destination is given', () => {
            const filter = new TerminalImageOutputFilter();
            filter.push('\u{1B}]1337;File=inline=1:UNFINISHED', new TerminalOutputQueue(128));

            expect(filter.finish()).toBe(0);
        });

        it('replaces a still-capturing sequence with the placeholder when a destination is given', () => {
            const filter = new TerminalImageOutputFilter();
            const output = new TerminalOutputQueue(128);
            filter.push('\u{1B}]1337;File=inline=1:UNFINISHED', output);

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
