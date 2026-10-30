import { describe, expect, it } from 'vitest';

import { isServerBuildStale } from '../server-staleness';

describe('isServerBuildStale', () => {
    it('flags a Server from a different build even when version and commit are identical', () => {
        // The dev rebuild-with-dirty-checkout case: same package version, same HEAD commit,
        // different code: only the per-build id can tell the builds apart.
        expect(
            isServerBuildStale(
                { buildId: 'build-b', commit: 'abc1234', version: '0.0.13' },
                { buildId: 'build-a', commit: 'abc1234', version: '0.0.13' },
            ),
        ).toBe(true);
    });

    it('treats a matching buildId as the same build regardless of other fields', () => {
        expect(
            isServerBuildStale(
                { buildId: 'build-a', commit: 'abc1234' },
                { buildId: 'build-a', commit: 'def5678' },
            ),
        ).toBe(false);
    });

    it('falls back to version and commit for a Server built before buildId existed', () => {
        expect(
            isServerBuildStale({ buildId: 'build-a', version: '0.0.13' }, { version: '0.0.12' }),
        ).toBe(true);
        expect(
            isServerBuildStale(
                { buildId: 'build-a', commit: 'abc1234', version: '0.0.13' },
                { commit: 'def5678', version: '0.0.13' },
            ),
        ).toBe(true);
        expect(
            isServerBuildStale(
                { buildId: 'build-a', commit: 'abc1234', version: '0.0.13' },
                { commit: 'abc1234', version: '0.0.13' },
            ),
        ).toBe(false);
    });

    it('never reports staleness from missing or unknown identities', () => {
        expect(isServerBuildStale({}, { version: '0.0.12' })).toBe(false);
        expect(
            isServerBuildStale(
                { buildId: 'unknown', commit: 'unknown', version: 'unknown' },
                { buildId: 'build-a', commit: 'abc1234', version: '0.0.13' },
            ),
        ).toBe(false);
    });
});
