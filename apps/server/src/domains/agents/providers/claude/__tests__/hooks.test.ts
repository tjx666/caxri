import { describe, expect, it } from 'vitest';

import { claudeHookAdapter } from '../hooks';

describe('claudeHookAdapter', () => {
    it('reports an API-error turn end as failed, not completed', () => {
        expect(claudeHookAdapter.bindings).toContainEqual(
            expect.objectContaining({ event: 'StopFailure', phase: 'turnFailed' }),
        );
        expect(claudeHookAdapter.bindings).not.toContainEqual(
            expect.objectContaining({ event: 'StopFailure', phase: 'turnFinished' }),
        );
    });
});
