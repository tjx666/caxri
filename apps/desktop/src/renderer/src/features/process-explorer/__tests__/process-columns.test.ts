import { describe, expect, it } from 'vitest';

import {
    DEFAULT_PROCESS_SORT,
    nextProcessSort,
    parseProcessTableState,
    PROCESS_COLUMN_MAX_WIDTH,
    processColumnWidthStyle,
    resolveProcessColumnWidths,
    serializeProcessTableState,
} from '../process-columns';

describe('resolveProcessColumnWidths', () => {
    it('stretches an untouched name column to fill the measured row', () => {
        expect(resolveProcessColumnWidths({}, 1_000)).toEqual({
            name: 704,
            cpu: 96,
            memory: 110,
            pid: 90,
        });
    });

    it('falls back to the definition widths before the first measurement', () => {
        expect(resolveProcessColumnWidths({}, 0).name).toBe(420);
    });

    it('never shrinks the auto-fitted name column below its minimum', () => {
        expect(resolveProcessColumnWidths({}, 200).name).toBe(160);
    });

    it('pins the name column once it has been dragged, whatever the row width', () => {
        expect(resolveProcessColumnWidths({ name: 320 }, 1_000).name).toBe(320);
    });

    it('clamps a stored width into the column range', () => {
        expect(resolveProcessColumnWidths({ cpu: 4, name: 9_000 }, 1_000)).toMatchObject({
            cpu: 64,
            name: PROCESS_COLUMN_MAX_WIDTH,
        });
    });
});

describe('processColumnWidthStyle', () => {
    it('emits one pixel custom property per column', () => {
        expect(processColumnWidthStyle({ name: 300, cpu: 110, memory: 140, pid: 90 })).toEqual({
            '--process-column-name': '300px',
            '--process-column-cpu': '110px',
            '--process-column-memory': '140px',
            '--process-column-pid': '90px',
        });
    });
});

describe('nextProcessSort', () => {
    it('opens a numeric column descending and a text column ascending', () => {
        expect(nextProcessSort(DEFAULT_PROCESS_SORT, 'memory')).toEqual({
            column: 'memory',
            direction: 'descending',
        });
        expect(nextProcessSort(DEFAULT_PROCESS_SORT, 'name')).toEqual({
            column: 'name',
            direction: 'ascending',
        });
    });

    it('flips direction when the active column is clicked again', () => {
        expect(nextProcessSort({ column: 'cpu', direction: 'descending' }, 'cpu')).toEqual({
            column: 'cpu',
            direction: 'ascending',
        });
    });
});

describe('parseProcessTableState', () => {
    it('round-trips a serialized state', () => {
        const state = {
            sort: { column: 'memory', direction: 'descending' },
            widths: { name: 300 },
        } as const;

        expect(parseProcessTableState(serializeProcessTableState(state))).toEqual(state);
    });

    it('falls back to the defaults for absent, unparsable, or invalid storage', () => {
        const fallback = { sort: DEFAULT_PROCESS_SORT, widths: {} };

        expect(parseProcessTableState(null)).toEqual(fallback);
        expect(parseProcessTableState('{ not json')).toEqual(fallback);
        expect(parseProcessTableState('{"sort":{"column":"threads","direction":"up"}}')).toEqual(
            fallback,
        );
        expect(parseProcessTableState('{"widths":{"cpu":"wide"}}')).toEqual(fallback);
    });

    it('clamps a persisted width that would push the other columns off screen', () => {
        expect(parseProcessTableState('{"widths":{"name":99999,"pid":1}}').widths).toEqual({
            name: PROCESS_COLUMN_MAX_WIDTH,
            pid: 56,
        });
    });
});
