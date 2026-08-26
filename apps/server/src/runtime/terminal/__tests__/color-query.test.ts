import { describe, expect, it, vi } from 'vitest';

import { oscColorReply, TerminalColorQueryResponder } from '../color-query';

const ESC = '\u{1B}';
const BEL = '\u{7}';
const ST = `${ESC}\\`;

describe('TerminalColorQueryResponder', () => {
    it('answers and strips BEL- and ST-terminated foreground and background queries', () => {
        const onQuery = vi.fn();
        const filter = new TerminalColorQueryResponder(onQuery);
        expect(filter.push(`before${ESC}]10;?${BEL}middle${ESC}]11;?${ST}after`)).toBe(
            'beforemiddleafter',
        );
        expect(onQuery.mock.calls).toEqual([
            [10, BEL],
            [11, ST],
        ]);
    });

    it('handles the Codex startup probe of both queries back to back', () => {
        const onQuery = vi.fn();
        const filter = new TerminalColorQueryResponder(onQuery);
        expect(filter.push(`${ESC}]10;?${ST}${ESC}]11;?${ST}`)).toBe('');
        expect(onQuery.mock.calls).toEqual([
            [10, ST],
            [11, ST],
        ]);
    });

    it('recognizes a query split across arbitrary chunk boundaries', () => {
        const onQuery = vi.fn();
        const filter = new TerminalColorQueryResponder(onQuery);
        let output = '';
        const query = `head${ESC}]11;?${ST}tail`;
        for (const character of query) output += filter.push(character);
        output += filter.finish();
        expect(output).toBe('headtail');
        expect(onQuery.mock.calls).toEqual([[11, ST]]);
    });

    it('passes through set-color commands and unrelated escape sequences untouched', () => {
        const onQuery = vi.fn();
        const filter = new TerminalColorQueryResponder(onQuery);
        const data = `${ESC}]11;#282a36${BEL}${ESC}[31mred${ESC}[0m${ESC}]10;rgb:ff/ff/ff${ST}`;
        expect(filter.push(data)).toBe(data);
        expect(onQuery).not.toHaveBeenCalled();
    });

    it('releases a held partial sequence that never completes', () => {
        const onQuery = vi.fn();
        const filter = new TerminalColorQueryResponder(onQuery);
        expect(filter.push(`prompt${ESC}]11;?`)).toBe('prompt');
        expect(filter.finish()).toBe(`${ESC}]11;?`);
        expect(onQuery).not.toHaveBeenCalled();
    });

    it('flushes a held tail that turns out not to be a query', () => {
        const onQuery = vi.fn();
        const filter = new TerminalColorQueryResponder(onQuery);
        expect(filter.push(`value${ESC}]1`)).toBe('value');
        expect(filter.push('337;File=name:x')).toBe(`${ESC}]1337;File=name:x`);
        expect(onQuery).not.toHaveBeenCalled();
    });
});

describe('oscColorReply', () => {
    it('doubles 8-bit channels into the 16-bit rgb reply form', () => {
        expect(oscColorReply(11, '#282a36', BEL)).toBe(`${ESC}]11;rgb:2828/2a2a/3636${BEL}`);
        expect(oscColorReply(10, '#F8F8F2', ST)).toBe(`${ESC}]10;rgb:F8F8/F8F8/F2F2${ST}`);
    });

    it('refuses a non-hex color instead of emitting a malformed reply', () => {
        expect(oscColorReply(11, 'transparent', BEL)).toBeUndefined();
    });
});
