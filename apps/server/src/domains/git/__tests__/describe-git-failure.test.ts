import { ProjectStatusSummaryErrorMessage } from 'caxri';
import { describe, expect, it } from 'vitest';

import { describeGitFailure } from '..';

describe('describeGitFailure', () => {
    it('distinguishes missing Git and timeout failures from non-repositories', () => {
        const missingGitError = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
        expect(describeGitFailure(missingGitError)).toBe(
            'Git is not installed or is unavailable on PATH.',
        );
        const timedOutError = Object.assign(new Error('timed out'), { killed: true });
        expect(describeGitFailure(timedOutError)).toBe('The Git operation timed out.');
        const notARepoError = Object.assign(new Error('exit 128'), {
            stderr: 'fatal: not a git repository',
        });
        expect(describeGitFailure(notARepoError, { missingRepoRoot: true })).toBe(
            ProjectStatusSummaryErrorMessage.missingGitRepository,
        );
        expect(describeGitFailure(notARepoError)).toBe(
            'The Git operation failed. Open Logs for details.',
        );
    });

    it('names the missing Xcode Command Line Tools instead of a generic failure', () => {
        const shimError = Object.assign(new Error('exit 1'), {
            stderr: 'xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools), missing xcrun at: /Library/Developer/CommandLineTools/usr/bin/xcrun',
        });
        expect(describeGitFailure(shimError)).toBe(
            'Git needs the Xcode Command Line Tools. Run xcode-select --install in Terminal, then retry.',
        );
    });
});
