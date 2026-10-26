import { describe, expect, it } from 'vitest';

import { formatByteSize } from '../format-size';

describe('formatByteSize', () => {
    it('returns null for an undefined size', () => {
        expect(formatByteSize(undefined)).toBeNull();
    });

    it('renders sub-kilobyte sizes in bytes', () => {
        expect(formatByteSize(0)).toBe('0 B');
        expect(formatByteSize(1_023)).toBe('1023 B');
    });

    it('renders kilobyte sizes rounded to the nearest KB', () => {
        expect(formatByteSize(1_024)).toBe('1 KB');
        expect(formatByteSize(16 * 1_024)).toBe('16 KB');
        expect(formatByteSize(1_024 * 1_024 - 1)).toBe('1024 KB');
    });

    it('renders megabyte sizes with one decimal place', () => {
        expect(formatByteSize(1_024 * 1_024)).toBe('1.0 MB');
        expect(formatByteSize(2.5 * 1_024 * 1_024)).toBe('2.5 MB');
    });
});
