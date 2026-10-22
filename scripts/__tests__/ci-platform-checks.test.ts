import { describe, expect, it } from 'vitest';

import { platformCheckCommands } from '../ci-platform-checks';
import { EXPECTED_PLATFORM_NEUTRAL_GATE_IDS } from './ci-platform-gates.fixture';

describe('full platform checks', () => {
    it('leaves Vitest to the sharded unit job while every other gate keeps its order', () => {
        expect(
            platformCheckCommands(
                {},
                { includeNodePtyPreparation: false, includeVitest: false },
            ).map(({ id }) => id),
        ).toEqual(EXPECTED_PLATFORM_NEUTRAL_GATE_IDS.filter((id) => id !== 'vitest'));
        expect(
            platformCheckCommands({}, { includeNodePtyPreparation: false }).map(({ id }) => id),
        ).toEqual(EXPECTED_PLATFORM_NEUTRAL_GATE_IDS);
    });
});
