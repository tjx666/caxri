import { describe, expect, it } from 'vitest';

import { platformCheckCommands } from '../ci-platform-checks';
import { assertGatesRunOnPlatform, MACOS_ONLY_CI_GATE_IDS } from '../ci-platform-gates';
import { EXPECTED_PLATFORM_NEUTRAL_GATE_IDS } from './ci-platform-gates.fixture';

describe('full platform checks', () => {
    it('leaves Vitest and ESLint to their own jobs while every other gate keeps its order', () => {
        expect(
            platformCheckCommands(
                {},
                {
                    includeNodePtyPreparation: false,
                    skipGates: ['vitest', 'eslint', 'bundle-budget'],
                },
            ).map(({ id }) => id),
        ).toEqual(
            EXPECTED_PLATFORM_NEUTRAL_GATE_IDS.filter(
                (id) => id !== 'vitest' && id !== 'eslint' && id !== 'bundle-budget',
            ),
        );
        expect(
            platformCheckCommands({}, { includeNodePtyPreparation: false }).map(({ id }) => id),
        ).toEqual(EXPECTED_PLATFORM_NEUTRAL_GATE_IDS);
    });

    it('refuses to run a macOS-only gate on Linux before any gate starts', () => {
        expect(MACOS_ONLY_CI_GATE_IDS).toEqual(['vitest', 'bundle-budget']);
        expect(() => assertGatesRunOnPlatform(['typescript', 'bundle-budget'], 'linux')).toThrow(
            /require macOS and cannot run on linux: bundle-budget/u,
        );
        expect(() =>
            assertGatesRunOnPlatform(['typescript', 'bundle-budget'], 'darwin'),
        ).not.toThrow();
        expect(() => assertGatesRunOnPlatform(['typescript', 'knip'], 'linux')).not.toThrow();
    });
});
