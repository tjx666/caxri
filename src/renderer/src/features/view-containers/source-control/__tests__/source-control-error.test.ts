import { describe, expect, it } from 'vitest';

import { describeSourceControlViewError } from '../source-control-error';

describe('describeSourceControlViewError', () => {
    it('rewords the not-a-repository message into product language', () => {
        expect(describeSourceControlViewError('The Project root is not a Git repository.')).toBe(
            'This folder is not a Git repository.',
        );
    });

    it('passes through other known, already user-facing Runtime messages', () => {
        expect(
            describeSourceControlViewError('Git is not installed or is unavailable on PATH.'),
        ).toBe('Git is not installed or is unavailable on PATH.');
        expect(describeSourceControlViewError('The Git operation timed out.')).toBe(
            'The Git operation timed out.',
        );
    });

    it('falls back to a friendly sentence for any unrecognized or raw error', () => {
        expect(describeSourceControlViewError('fatal: unable to read config file')).toBe(
            'This folder is not a Git repository.',
        );
        expect(
            describeSourceControlViewError(
                'The Git operation failed. See Runtime logs for details.',
            ),
        ).toBe('This folder is not a Git repository.');
    });
});
