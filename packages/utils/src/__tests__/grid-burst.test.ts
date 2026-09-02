import { describe, expect, it } from 'vitest';

import { GridBurstAccumulator } from '../grid-burst';

describe('GridBurstAccumulator', () => {
    it('summarizes repeated intermediate grids without losing the narrow or final size', () => {
        const accumulator = new GridBurstAccumulator();

        accumulator.sample({ cols: 153, rows: 59 });
        accumulator.sample({ cols: 4, rows: 59 });
        accumulator.sample({ cols: 4, rows: 59 });
        accumulator.sample({ cols: 80, rows: 59 });

        const expected = {
            sampleCount: 4,
            changeCount: 2,
            start: { cols: 153, rows: 59 },
            minimum: { cols: 4, rows: 59 },
            maximum: { cols: 153, rows: 59 },
            final: { cols: 80, rows: 59 },
        };
        expect(accumulator.snapshot()).toEqual(expected);
        expect(accumulator.snapshot()).toEqual(expected);
        expect(accumulator.reset()).toEqual(expected);
        expect(accumulator.snapshot()).toBeUndefined();
    });

    it('tracks row bounds independently and counts only adjacent grid changes', () => {
        const accumulator = new GridBurstAccumulator();

        accumulator.sample({ cols: 80, rows: 40 });
        accumulator.sample({ cols: 80, rows: 20 });
        accumulator.sample({ cols: 80, rows: 20 });
        accumulator.sample({ cols: 120, rows: 60 });

        expect(accumulator.snapshot()).toEqual({
            sampleCount: 4,
            changeCount: 2,
            start: { cols: 80, rows: 40 },
            minimum: { cols: 80, rows: 20 },
            maximum: { cols: 120, rows: 60 },
            final: { cols: 120, rows: 60 },
        });
    });

    it('reports a one-step resize as a real transition when seeded from the previous grid', () => {
        const accumulator = new GridBurstAccumulator();

        accumulator.seed({ cols: 80, rows: 40 });
        accumulator.sample({ cols: 120, rows: 60 });

        expect(accumulator.snapshot()).toEqual({
            sampleCount: 1,
            changeCount: 1,
            start: { cols: 80, rows: 40 },
            minimum: { cols: 80, rows: 40 },
            maximum: { cols: 120, rows: 60 },
            final: { cols: 120, rows: 60 },
        });
    });

    it('reports no change when a seeded burst only re-samples the existing grid', () => {
        const accumulator = new GridBurstAccumulator();

        accumulator.seed({ cols: 80, rows: 40 });
        accumulator.sample({ cols: 80, rows: 40 });

        expect(accumulator.snapshot()).toEqual({
            sampleCount: 1,
            changeCount: 0,
            start: { cols: 80, rows: 40 },
            minimum: { cols: 80, rows: 40 },
            maximum: { cols: 80, rows: 40 },
            final: { cols: 80, rows: 40 },
        });
    });

    it('does not count the seed toward sampleCount and still bounds min/max around it', () => {
        const accumulator = new GridBurstAccumulator();

        accumulator.seed({ cols: 120, rows: 40 });
        accumulator.sample({ cols: 4, rows: 12 });
        accumulator.sample({ cols: 80, rows: 30 });

        expect(accumulator.snapshot()).toEqual({
            sampleCount: 2,
            changeCount: 2,
            start: { cols: 120, rows: 40 },
            minimum: { cols: 4, rows: 12 },
            maximum: { cols: 120, rows: 40 },
            final: { cols: 80, rows: 30 },
        });
    });
});
