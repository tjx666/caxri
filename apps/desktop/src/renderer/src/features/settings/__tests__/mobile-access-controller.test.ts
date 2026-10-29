import { describe, expect, it } from 'vitest';

import {
    initialMobileAccessState,
    mobileAccessReducer,
} from '../hooks/use-mobile-access-controller';

describe('mobile access controller load state', () => {
    it('distinguishes an initial failure from loading and allows a clean retry', () => {
        const failed = mobileAccessReducer(initialMobileAccessState, { type: 'load-failed' });
        expect(failed).toMatchObject({
            error: 'settings.mobileAccess.error.load',
            loadState: 'error',
        });
        expect(failed.status).toBeUndefined();

        const retrying = mobileAccessReducer(failed, { type: 'load-started' });
        expect(retrying).toMatchObject({ error: undefined, loadState: 'loading' });
    });
});
