import { describe, expect, it } from 'vitest';

import { validateFailureIsolationResult } from '../run-e2e-failure-isolation';

describe('E2E failure-isolation result', () => {
    const expectedOutput = `
controlled worker interruption preserves the original failure
replacement worker reacquires the desktop after controlled interruption
1 failed
1 passed
`;

    it('accepts exactly one original worker failure followed by one replacement pass', () => {
        expect(validateFailureIsolationResult(1, expectedOutput)).toEqual({
            originalFailure: true,
            replacementPassed: true,
        });
    });

    it('rejects a missing failure, missing recovery, or lease cascade', () => {
        expect(() => validateFailureIsolationResult(0, expectedOutput)).toThrow(
            'must retain its original non-zero result',
        );
        expect(() =>
            validateFailureIsolationResult(1, expectedOutput.replace('1 passed', '2 failed')),
        ).toThrow('replacement worker did not pass');
        expect(() =>
            validateFailureIsolationResult(
                1,
                `${expectedOutput}\nDesktop is in use by Electron E2E`,
            ),
        ).toThrow('lock or lease cascade');
    });
});
