import { describe, expect, it } from 'vitest';

import { isImeComposing } from './ime';

describe('isImeComposing', () => {
    it('detects a composing React keydown through its native event', () => {
        expect(isImeComposing({ keyCode: 13, nativeEvent: { isComposing: true } })).toBe(true);
    });

    it('detects a composing DOM keydown', () => {
        expect(isImeComposing({ keyCode: 13, isComposing: true })).toBe(true);
    });

    it('treats keyCode 229 as composing on engines that report only that', () => {
        expect(isImeComposing({ keyCode: 229, nativeEvent: { isComposing: false } })).toBe(true);
    });

    it('lets a plain Enter through', () => {
        expect(isImeComposing({ keyCode: 13, nativeEvent: { isComposing: false } })).toBe(false);
        expect(isImeComposing({ keyCode: 13, isComposing: false })).toBe(false);
    });
});
