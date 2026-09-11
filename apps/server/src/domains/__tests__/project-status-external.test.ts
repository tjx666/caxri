import { describe, expect, it } from 'vitest';

import type { CliFailureKind } from '../external-status';
import { projectStatusCliError } from '../project-status-external';

const NON_LOG_FAILURE_KINDS: Array<Exclude<CliFailureKind, 'other'>> = [
    'not-found',
    'not-logged-in',
    'not-linked',
    'rate-limited',
    'timeout',
];

describe('projectStatusCliError', () => {
    it.each(NON_LOG_FAILURE_KINDS)('keeps %s errors non-actionable', (kind) => {
        expect(projectStatusCliError('linear', kind)).not.toHaveProperty('detailsView');
    });

    it('routes generic CLI failure details to Logs', () => {
        expect(projectStatusCliError('linear', 'other')).toHaveProperty('detailsView', 'logs');
    });

    it('names the failing subject instead of promising log details that are never recorded', () => {
        const error = projectStatusCliError('linear', 'other', 'LOBE-14029');
        expect(error.message).toBe('linear: LOBE-14029 failed');
        expect(error.hint).toContain('LOBE-14029');
        expect(error.hint).not.toContain('See Runtime logs for details');
        expect(projectStatusCliError('linear', 'other').hint).not.toContain(
            'See Runtime logs for details',
        );
    });
});
