import { describe, expect, it } from 'vitest';

import { errorCode, isInside } from './report-paths';

describe('isInside', () => {
    it('rejects a candidate equal to the parent', () => {
        expect(isInside('/records', '/records')).toBe(false);
    });

    it('accepts a direct child path', () => {
        expect(isInside('/records', '/records/round-1')).toBe(true);
    });

    it('accepts a nested descendant path', () => {
        expect(isInside('/records', '/records/round-1/assets/terminal.png')).toBe(true);
    });

    it('rejects a sibling path that shares a name prefix', () => {
        expect(isInside('/records', '/records-legacy/round-1')).toBe(false);
    });

    it('rejects a parent traversal candidate', () => {
        expect(isInside('/records/round-1', '/records')).toBe(false);
    });

    it('rejects a candidate that escapes the parent via ..', () => {
        expect(isInside('/records', '/records/round-1/../../outside')).toBe(false);
    });

    it('rejects an absolute candidate entirely outside the parent', () => {
        expect(isInside('/records', '/tmp/outside')).toBe(false);
    });
});

describe('errorCode', () => {
    it('reads the code from a Node.js system error', () => {
        expect(errorCode({ code: 'ENOENT' })).toBe('ENOENT');
    });

    it('returns undefined when the error has no code property', () => {
        expect(errorCode(new Error('plain error'))).toBeUndefined();
    });

    it('returns undefined for non-string code values', () => {
        expect(errorCode({ code: 42 })).toBeUndefined();
    });

    it('returns undefined for null or non-object inputs', () => {
        expect(errorCode(null)).toBeUndefined();
        expect(errorCode('ENOENT')).toBeUndefined();
        expect(errorCode(undefined)).toBeUndefined();
    });
});
