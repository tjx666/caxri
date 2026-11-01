import { describe, expect, it } from 'vitest';

import {
    DEVICE_EXEC_DEFAULT_TIMEOUT_MS,
    DEVICE_EXEC_STREAM_MAX_JSON_BYTES,
    deviceActionOutcomeSchema,
    fitDeviceExecStream,
    mobileDeviceActionMethods,
} from '../mobile-device-action-contract';

const jsonBytes = (value: string) => new TextEncoder().encode(JSON.stringify(value)).length;

describe('fitDeviceExecStream', () => {
    it('keeps output that fits untouched', () => {
        expect(fitDeviceExecStream('hello\n')).toEqual({ text: 'hello\n', truncated: false });
    });

    it.each([
        ['plain Latin', 'a'.repeat(30_000)],
        ['CJK', '中'.repeat(10_000)],
        ['escaped control characters', '\u{1}'.repeat(5_000)],
        ['astral emoji', '😀'.repeat(10_000)],
    ])('cuts %s output to the JSON byte budget on a code point boundary', (_name, value) => {
        const { text, truncated } = fitDeviceExecStream(value);
        expect(truncated).toBe(true);
        expect(jsonBytes(text)).toBeLessThanOrEqual(DEVICE_EXEC_STREAM_MAX_JSON_BYTES);
        expect(value.startsWith(text)).toBe(true);
        expect(text.isWellFormed()).toBe(true);
        expect(jsonBytes(text + [...value][[...text].length])).toBeGreaterThan(
            DEVICE_EXEC_STREAM_MAX_JSON_BYTES,
        );
    });
});

describe('mobile.deviceAction contract', () => {
    it('defaults the exec deadline and rejects an empty command', () => {
        const parameters = mobileDeviceActionMethods['mobile.deviceAction.exec'].params;
        expect(parameters.parse({ argv: ['ls'] })).toEqual({
            argv: ['ls'],
            timeoutMs: DEVICE_EXEC_DEFAULT_TIMEOUT_MS,
        });
        expect(parameters.safeParse({ argv: [] }).success).toBe(false);
    });

    it('accepts only the closed failure reasons', () => {
        expect(
            deviceActionOutcomeSchema.safeParse({ status: 'failed', reason: 'disabled' }).success,
        ).toBe(true);
        expect(
            deviceActionOutcomeSchema.safeParse({ status: 'failed', reason: 'other' }).success,
        ).toBe(false);
    });
});
