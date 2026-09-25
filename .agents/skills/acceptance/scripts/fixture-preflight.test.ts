import { describe, expect, it } from 'vitest';

import type { TerminalFixture } from './fixture-preflight';
import {
    createTerminalFixturePreflightReceipt,
    preflightTerminalFixture,
} from './fixture-preflight';

function fixture(overrides: Partial<TerminalFixture> = {}): TerminalFixture {
    return {
        columns: 8,
        domRowCount: 3,
        firstGridMarker: { columns: 8, generation: 'fixture-1', rows: 3 },
        generation: 'fixture-1',
        lines: ['│12345 │', '│A中🙂 │', '│e\u{301}     │'],
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
            fixture({ lines: ['│12345 │', '│中🙂   │', '│e\u{301}     │'] }),
        );

        expect(result.status).toBe('fixture_blocked');
        expect(result.errors).toContainEqual({
            code: 'fixture-cell-width',
            detail: 'Line 2 occupies 9 cells instead of 8',
        });
        expect(result).not.toHaveProperty('verdict');
        expect(createTerminalFixturePreflightReceipt(fixture()).result.status).toBe('ready');
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

    it('accepts frozen uppercase case ids and rejects unsafe ids before writing a receipt', () => {
        expect(createTerminalFixturePreflightReceipt(fixture(), 'MOB-SEC-01').caseId).toBe(
            'MOB-SEC-01',
        );
        expect(() => createTerminalFixturePreflightReceipt(fixture(), 'MOB/SEC/01')).toThrow(
            'ASCII letters, numbers, and hyphens',
        );
    });

    it('binds an observed Terminal grid to its exact source and isolated launch', () => {
        const identity = { launchId: 'launch-123', sourceCommit: 'a'.repeat(40) };
        expect(
            createTerminalFixturePreflightReceipt(fixture(), 'MOB-TERM-01', identity),
        ).toMatchObject({
            caseId: 'MOB-TERM-01',
            ...identity,
            result: { status: 'ready' },
        });
        expect(() =>
            createTerminalFixturePreflightReceipt(fixture(), 'MOB-TERM-01', {
                ...identity,
                sourceCommit: 'wrong',
            }),
        ).toThrow();
        expect(() =>
            createTerminalFixturePreflightReceipt(fixture(), 'MOB-TERM-01', {
                ...identity,
                launchId: '',
            }),
        ).toThrow();
    });
});
