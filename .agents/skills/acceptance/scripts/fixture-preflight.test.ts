import { describe, expect, it } from 'vitest';

import { preflightTerminalFixture, type TerminalFixture } from './fixture-preflight';

function fixture(overrides: Partial<TerminalFixture> = {}): TerminalFixture {
    return {
        columns: 8,
        domRowCount: 3,
        firstGridMarker: { columns: 8, generation: 'fixture-1', rows: 3 },
        generation: 'fixture-1',
        lines: ['│12345 │', '│A中🙂 │', '│e\u0301     │'],
        rows: 3,
        ...overrides,
    };
}

describe('Acceptance Terminal fixture preflight', () => {
    it('measures ASCII, CJK, emoji, and combining characters in terminal cells', () => {
        expect(preflightTerminalFixture(fixture())).toEqual({
            errors: [],
            lines: [
                { index: 0, width: 8 },
                { index: 1, width: 8 },
                { index: 2, width: 8 },
            ],
            status: 'ready',
        });
    });

    it('blocks the old UTF-16-padding failure before product verdict or recording', () => {
        const result = preflightTerminalFixture(
            fixture({ lines: ['│12345 │', '│中🙂   │', '│e\u0301     │'] }),
        );

        expect(result.status).toBe('fixture_blocked');
        expect(result.errors).toContainEqual({
            code: 'fixture-cell-width',
            detail: 'Line 2 occupies 9 cells instead of 8',
        });
        expect(result).not.toHaveProperty('verdict');
    });

    it('blocks stale generation, grid, DOM rows, and incomplete borders together', () => {
        const result = preflightTerminalFixture(
            fixture({
                domRowCount: 2,
                firstGridMarker: { columns: 9, generation: 'stale', rows: 2 },
                lines: [' 1234 │', '│A中🙂 │'],
            }),
        );

        expect(result.status).toBe('fixture_blocked');
        expect(new Set(result.errors.map(({ code }) => code))).toEqual(
            new Set([
                'fixture-border',
                'fixture-cell-width',
                'fixture-dom-row-count',
                'fixture-grid-marker',
                'fixture-row-count',
            ]),
        );
    });
});
