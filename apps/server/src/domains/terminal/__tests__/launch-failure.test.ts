import { describe, expect, it } from 'vitest';

import { isMachinePtyExhausted } from '../launch-failure';

describe('isMachinePtyExhausted', () => {
    it.each([
        { inUse: 100, expected: true },
        { inUse: 98, expected: true },
        { inUse: 97, expected: false },
    ])('treats $inUse of 100 slots as exhausted: $expected', async ({ inUse, expected }) => {
        expect(await isMachinePtyExhausted(() => Promise.resolve({ inUse, limit: 100 }))).toBe(
            expected,
        );
    });

    it('never blames PTYs when the reading fails or is unavailable', async () => {
        expect(await isMachinePtyExhausted(() => Promise.reject(new Error('lsof missing')))).toBe(
            false,
        );
        expect(await isMachinePtyExhausted(() => Promise.resolve(undefined))).toBe(false);
    });
});
