import { describe, expect, it } from 'vitest';

import {
    TERMINAL_IMAGE_RECOVERY_PLACEHOLDER,
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
