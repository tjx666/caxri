import { describe, expect, it } from 'vitest';

import { isHostBuildStale } from '../host-staleness';

describe('isHostBuildStale', () => {
    it('flags a Host from a different build even when version and commit are identical', () => {
        // The dev rebuild-with-dirty-checkout case: same package version, same HEAD commit,
        // different code — only the per-build id can tell the builds apart.
        expect(
            isHostBuildStale(
                { buildId: 'build-b', commit: 'abc1234', version: '0.0.13' },
                { buildId: 'build-a', commit: 'abc1234', version: '0.0.13' },
            ),
        ).toBe(true);
    });

    it('treats a matching buildId as the same build regardless of other fields', () => {
        expect(
            isHostBuildStale(
                { buildId: 'build-a', commit: 'abc1234' },
                { buildId: 'build-a', commit: 'def5678' },
            ),
        ).toBe(false);
    });

    it('falls back to version and commit for a Host built before buildId existed', () => {
        expect(
            isHostBuildStale({ buildId: 'build-a', version: '0.0.13' }, { version: '0.0.12' }),
        ).toBe(true);
        expect(
            isHostBuildStale(
                { buildId: 'build-a', commit: 'abc1234', version: '0.0.13' },
                { commit: 'def5678', version: '0.0.13' },
            ),
        ).toBe(true);
        expect(
            isHostBuildStale(
                { buildId: 'build-a', commit: 'abc1234', version: '0.0.13' },
                { commit: 'abc1234', version: '0.0.13' },
            ),
        ).toBe(false);
    });

    it('never reports staleness from missing or unknown identities', () => {
        expect(isHostBuildStale({}, { version: '0.0.12' })).toBe(false);
        expect(
            isHostBuildStale(
                { buildId: 'unknown', commit: 'unknown', version: 'unknown' },
                { buildId: 'build-a', commit: 'abc1234', version: '0.0.13' },
            ),
        ).toBe(false);
    });
});
