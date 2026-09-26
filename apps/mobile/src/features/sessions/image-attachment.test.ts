import { describe, expect, it } from 'vitest';

import { splitMobileImage } from './image-attachment';

describe('mobile image chunking', () => {
    it('keeps each chunk within the encrypted gateway request limit', () => {
        const chunks = splitMobileImage('a'.repeat(50_000));
        expect(chunks.map((chunk) => chunk.length)).toEqual([24_000, 24_000, 2_000]);
    });

    it('rejects oversized images before upload', () => {
        expect(() => splitMobileImage('a'.repeat(4 * 1_024 * 1_024 + 1))).toThrow();
    });

    it('removes Android clipboard line breaks before chunking', () => {
        expect(splitMobileImage('data:image/jpeg;base64,/9j/\nAA==')).toEqual(['/9j/AA==']);
        expect(() => splitMobileImage('/9j/?')).toThrow();
    });
});
