import { CaxriError } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { shouldToastQueryError } from './client';

describe('query error notifications', () => {
    it('treats a stale controlled-view cancellation as a non-fault', () => {
        expect(
            shouldToastQueryError(
                true,
                new CaxriError('CANCELLED', 'Controlled view scope is no longer active'),
            ),
        ).toBe(false);
    });

    it('still reports an actionable query failure', () => {
        expect(shouldToastQueryError(true, new CaxriError('IO', 'Unable to read file'))).toBe(true);
    });
});
