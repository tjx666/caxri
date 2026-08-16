import { describe, expect, it } from 'vitest';

import { formatBytes } from '../format-bytes';

describe('formatBytes', () => {
    it('keeps whole bytes below 1 KB', () => {
        expect(formatBytes(0)).toBe('0 B');
        expect(formatBytes(1023)).toBe('1023 B');
    });

    it('formats binary KB and MB with one decimal', () => {
        expect(formatBytes(1024)).toBe('1.0 KB');
        expect(formatBytes(1536)).toBe('1.5 KB');
        expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
        expect(formatBytes(52_428_800)).toBe('50.0 MB');
    });
});
