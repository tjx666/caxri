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
        expect(describeGitFailure(notARepoError)).toBe(
            ProjectStatusSummaryErrorMessage.missingGitRepository,
        );
    });
});
