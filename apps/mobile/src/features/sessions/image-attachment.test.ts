import { describe, expect, it } from 'vitest';

import {
    chatThumbnailSize,
    isWithinChatThumbnailLimit,
    splitMobileImage,
} from './image-attachment';

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

    it('fits a Chat thumbnail into its box and the projection limit', () => {
        expect(chatThumbnailSize(4_000, 3_000)).toEqual({ width: 384, height: 288 });
        expect(chatThumbnailSize(1_000, 3_000)).toEqual({ width: 128, height: 384 });
        expect(chatThumbnailSize(200, 100)).toEqual({ width: 200, height: 100 });
        expect(isWithinChatThumbnailLimit('a'.repeat(40_000))).toBe(true);
        expect(isWithinChatThumbnailLimit('a'.repeat(49_152))).toBe(false);
        expect(isWithinChatThumbnailLimit('')).toBe(false);
    });
});
