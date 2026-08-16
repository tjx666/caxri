import { describe, expect, it } from 'vitest';

import { bugReportScreenshot, bugReportText } from '../bug-report-contract.js';

describe('bugReportText', () => {
    it('accepts plain multi-line text including tab, newline, and carriage return', () => {
        expect(bugReportText.safeParse('Steps to reproduce:\n1. Open\t2. Crash\r\n').success).toBe(
            true,
        );
    });

    it('rejects an empty string', () => {
        expect(bugReportText.safeParse('').success).toBe(false);
    });

    it('rejects a NUL control character', () => {
        expect(bugReportText.safeParse(`before${String.fromCodePoint(0)}after`).success).toBe(
            false,
        );
    });

    it('rejects the DEL control character', () => {
        expect(bugReportText.safeParse(`before${String.fromCodePoint(127)}after`).success).toBe(
            false,
        );
    });

    it('rejects other C0 control characters below space', () => {
        expect(bugReportText.safeParse(`before${String.fromCodePoint(1)}after`).success).toBe(
            false,
        );
    });

    it('rejects text over the maximum length', () => {
        expect(bugReportText.safeParse('a'.repeat(48 * 1024 + 1)).success).toBe(false);
    });

    it('accepts text at the maximum length', () => {
        expect(bugReportText.safeParse('a'.repeat(48 * 1024)).success).toBe(true);
    });
});

describe('bugReportScreenshot', () => {
    const base = { width: 100, height: 100 };

    it('accepts a JPEG data URL', () => {
        expect(
            bugReportScreenshot.safeParse({
                ...base,
                dataUrl: 'data:image/jpeg;base64,AAAA',
            }).success,
        ).toBe(true);
    });

    it('rejects a non-JPEG data URL prefix', () => {
        expect(
            bugReportScreenshot.safeParse({
                ...base,
                dataUrl: 'data:image/png;base64,AAAA',
            }).success,
        ).toBe(false);
    });

    it('rejects a data URL exceeding the maximum size', () => {
        expect(
            bugReportScreenshot.safeParse({
                ...base,
                dataUrl: `data:image/jpeg;base64,${'A'.repeat(12 * 1024 * 1024)}`,
            }).success,
        ).toBe(false);
    });

    it('rejects non-positive dimensions', () => {
        expect(
            bugReportScreenshot.safeParse({
                dataUrl: 'data:image/jpeg;base64,AAAA',
                width: 0,
                height: 100,
            }).success,
        ).toBe(false);
    });
});
