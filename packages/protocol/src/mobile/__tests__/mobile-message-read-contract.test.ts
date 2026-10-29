import { describe, expect, it } from 'vitest';

import {
    MOBILE_MESSAGE_CHUNK_LENGTH,
    MOBILE_MESSAGE_READ_MAX_BYTES,
    readMobileMessageChunk,
} from '../mobile-message-read-contract.js';

const readAll = (text: string): string[] => {
    const slices: string[] = [];
    let offset = 0;
    for (;;) {
        const chunk = readMobileMessageChunk(text, offset);
        slices.push(chunk.text);
        if (chunk.nextOffset === undefined) return slices;
        offset = chunk.nextOffset;
    }
};

describe('readMobileMessageChunk', () => {
    it('returns a short message whole', () => {
        expect(readMobileMessageChunk('hello', 0)).toEqual({ text: 'hello', totalLength: 5 });
    });

    it('slices a message past the 16 KiB send limit so the slices join to the original', () => {
        const text = `first line\n${'x'.repeat(40_000)}\nlast line`;
        const slices = readAll(text);
        expect(slices.length).toBeGreaterThan(1);
        expect(slices.every((slice) => slice.length <= MOBILE_MESSAGE_CHUNK_LENGTH)).toBe(true);
        expect(slices.join('')).toBe(text);
    });

    it('keeps every slice inside the frame budget for escape-heavy and wide text', () => {
        const text = '"\n'.repeat(60_000) + '\u{4E2D}'.repeat(30_000);
        const slices = readAll(text);
        expect(slices.join('')).toBe(text);
        for (const slice of slices)
            expect(new TextEncoder().encode(JSON.stringify(slice)).length).toBeLessThanOrEqual(
                40 * 1_024,
            );
    });

    it('never splits a surrogate pair between slices', () => {
        const text = '\u{1F600}'.repeat(12_000);
        const slices = readAll(text);
        expect(slices.join('')).toBe(text);
        for (const slice of slices) expect(slice.endsWith('\u{D83D}')).toBe(false);
    });

    it('refuses a message over the read bound and an offset past the end', () => {
        expect(() =>
            readMobileMessageChunk('a'.repeat(MOBILE_MESSAGE_READ_MAX_BYTES + 1), 0),
        ).toThrow(expect.objectContaining({ code: 'VALIDATION' }));
        expect(
            readMobileMessageChunk('a'.repeat(MOBILE_MESSAGE_READ_MAX_BYTES), 0).totalLength,
        ).toBe(MOBILE_MESSAGE_READ_MAX_BYTES);
        expect(() => readMobileMessageChunk('abc', 4)).toThrow(
            expect.objectContaining({ code: 'VALIDATION' }),
        );
    });
});
