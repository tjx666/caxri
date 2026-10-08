import type { IntegerSettingSpec } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { formatIntegerSettingValue, parseIntegerSettingInput } from '../integer-control-values';

const MEBIBYTE = 1024 * 1024;

/**
 * Edited in its stored unit: seconds in, seconds on disk.
 */
const completionThreshold: IntegerSettingSpec = {
    kind: 'integer',
    key: 'agents.notifications.completionThresholdSeconds',
    title: 'Completed turn threshold',
    category: 'notifications',
    min: 0,
    max: 3600,
    default: 60,
    display: { unit: 'seconds' },
};

/**
 * Stored in bytes, edited in megabytes, so the copy must name the scaled bounds.
 */
const maxFileBytes: IntegerSettingSpec = {
    kind: 'integer',
    key: 'files.maxFileBytes',
    title: 'Maximum editable file size',
    category: 'files',
    min: 1024,
    max: 16 * MEBIBYTE,
    default: 2 * MEBIBYTE,
    display: { unit: 'MB', scale: MEBIBYTE, step: 0.5 },
};

const RANGE_ERROR = { error: 'Enter a number between 0 and 3600 seconds.', status: 'invalid' };
const INCOMPLETE = { status: 'incomplete' };

describe('parseIntegerSettingInput', () => {
    it('accepts a value inside the range, including both bounds', () => {
        expect(parseIntegerSettingInput('120', completionThreshold)).toEqual({
            status: 'valid',
            value: 120,
        });
        expect(parseIntegerSettingInput('0', completionThreshold)).toEqual({
            status: 'valid',
            value: 0,
        });
        expect(parseIntegerSettingInput('3600', completionThreshold)).toEqual({
            status: 'valid',
            value: 3600,
        });
    });

    it('rejects a value above the maximum with plain-language copy', () => {
        expect(parseIntegerSettingInput('6099999', completionThreshold)).toEqual(RANGE_ERROR);
        expect(parseIntegerSettingInput('3601', completionThreshold)).toEqual(RANGE_ERROR);
    });

    it('rejects a value below the minimum', () => {
        expect(parseIntegerSettingInput('-1', completionThreshold)).toEqual(RANGE_ERROR);
    });

    it('treats an empty field as unfinished rather than zero or wrong', () => {
        expect(parseIntegerSettingInput('', completionThreshold)).toEqual(INCOMPLETE);
        expect(parseIntegerSettingInput(' '.repeat(3), completionThreshold)).toEqual(INCOMPLETE);
    });

    /**
     * `<input type="number">` reports an empty string for text it cannot parse yet, so `2.` and `-` (real keystrokes on
     * the way to `2.5` and `-1`) reach this function as `''` and `'-'`. Calling either invalid flashed a range error
     * over an entry that was never out of range. `files.maxFileBytes` has `step: 0.5`, so decimals are the expected way
     * to type it.
     */
    it('does not accuse a half-typed decimal of being out of range', () => {
        expect(parseIntegerSettingInput('', maxFileBytes)).toEqual(INCOMPLETE);
        expect(parseIntegerSettingInput('-', maxFileBytes)).toEqual(INCOMPLETE);
        expect(parseIntegerSettingInput('2.5', maxFileBytes)).toEqual({
            status: 'valid',
            value: 2.5 * MEBIBYTE,
        });
    });

    it('treats text that is not a number as unfinished, never as a value', () => {
        expect(parseIntegerSettingInput('abc', completionThreshold)).toEqual(INCOMPLETE);
        expect(parseIntegerSettingInput('12px', completionThreshold)).toEqual(INCOMPLETE);
        expect(parseIntegerSettingInput('Infinity', completionThreshold)).toEqual(INCOMPLETE);
    });

    it('rejects a fraction when the field edits the stored unit, instead of rounding it silently', () => {
        expect(parseIntegerSettingInput('60.5', completionThreshold)).toEqual({
            error: 'Enter a whole number between 0 and 3600 seconds.',
            status: 'invalid',
        });
    });

    it('converts a scaled field into stored units and names the scaled bounds', () => {
        expect(parseIntegerSettingInput('1.5', maxFileBytes)).toEqual({
            status: 'valid',
            value: 1.5 * MEBIBYTE,
        });
        expect(parseIntegerSettingInput('16', maxFileBytes)).toEqual({
            status: 'valid',
            value: 16 * MEBIBYTE,
        });
        expect(parseIntegerSettingInput('17', maxFileBytes)).toEqual({
            error: 'Enter a number between 0.001 and 16 MB.',
            status: 'invalid',
        });
    });

    it('accepts the lower bound exactly as the copy states it', () => {
        expect(parseIntegerSettingInput('0.001', maxFileBytes)).toEqual({
            status: 'valid',
            value: 1049,
        });
    });
});

describe('formatIntegerSettingValue', () => {
    it('shows the stored value in the edited unit', () => {
        expect(formatIntegerSettingValue(60, completionThreshold)).toBe('60');
        expect(formatIntegerSettingValue(2 * MEBIBYTE, maxFileBytes)).toBe('2');
    });
});
