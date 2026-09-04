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
});
