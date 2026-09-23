import { describe, expect, it } from 'vitest';

import { safeValidationEnvironment } from '../validation-run';

describe('formal validation environment', () => {
    it('forwards the authorization a canonical gate needs to run outside CI', () => {
        // `bun run test` is a canonical gate a `full` deep review requires a receipt for, and it refuses to run
        // without this flag. Dropping it made that receipt impossible to produce locally.
        expect(
            safeValidationEnvironment({ CAXRI_FULL_SUITE_AUTHORIZED: '1', PATH: '/usr/bin' }),
        ).toEqual({ CAXRI_FULL_SUITE_AUTHORIZED: '1', PATH: '/usr/bin' });
    });

    it('drops credentials, whose values would otherwise reach a durable validation log', () => {
        expect(
            safeValidationEnvironment({
                AWS_SECRET_ACCESS_KEY: 'secret',
                GH_TOKEN: 'secret',
                GITHUB_TOKEN: 'secret',
                PATH: '/usr/bin',
            }),
        ).toEqual({ PATH: '/usr/bin' });
    });

    it('omits an unset key rather than forwarding it as undefined', () => {
        expect(Object.hasOwn(safeValidationEnvironment({ PATH: '/usr/bin' }), 'CI')).toBe(false);
    });
});
