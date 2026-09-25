import { describe, expect, it } from 'vitest';

import type { TerminalFixture } from './fixture-preflight';
import {
    createTerminalFixturePreflightReceipt,
    preflightTerminalFixture,
    verifyTerminalFixturePreflightReceipt,
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
                { bordersIntact: true, index: 0, width: 8 },
                { bordersIntact: true, index: 1, width: 8 },
                { bordersIntact: true, index: 2, width: 8 },
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

    it('persists only Terminal row measurements and rejects raw rows or extra receipt fields', () => {
        const observed = fixture({ lines: ['│opaque│', '│A中🙂 │', '│e\u{301}     │'] });
        const receipt = createTerminalFixturePreflightReceipt(observed, 'MOB-TERM-01');

        expect(receipt.schemaVersion).toBe(2);
        expect(receipt.fixture).not.toHaveProperty('lines');
        expect(receipt.result.lines).toEqual([
            { bordersIntact: true, index: 0, width: 8 },
            { bordersIntact: true, index: 1, width: 8 },
            { bordersIntact: true, index: 2, width: 8 },
        ]);
        expect(JSON.stringify(receipt)).not.toContain('opaque');
        expect(() => verifyTerminalFixturePreflightReceipt(receipt)).not.toThrow();
        expect(() =>
            verifyTerminalFixturePreflightReceipt({
                ...receipt,
                fixture: { ...receipt.fixture, lines: observed.lines },
            }),
        ).toThrow();
        expect(() =>
            verifyTerminalFixturePreflightReceipt({ ...receipt, extra: 'untrusted' }),
        ).toThrow();
        expect(() =>
            verifyTerminalFixturePreflightReceipt({
                ...receipt,
                fixture: {
                    ...receipt.fixture,
                    firstGridMarker: { ...receipt.fixture.firstGridMarker, extra: 'untrusted' },
                },
            }),
        ).toThrow();
        expect(() =>
            verifyTerminalFixturePreflightReceipt({
                ...receipt,
                result: {
                    ...receipt.result,
                    lines: [
                        { ...receipt.result.lines[0], extra: 'untrusted' },
                        ...receipt.result.lines.slice(1),
                    ],
                },
            }),
        ).toThrow();
        expect(() =>
            verifyTerminalFixturePreflightReceipt({ ...receipt, schemaVersion: 1 }),
        ).toThrow();
    });

    it('recomputes blocked status and errors from persisted row metrics', () => {
        const receipt = createTerminalFixturePreflightReceipt(
            fixture({ lines: [' 1234 │', '│A中🙂 │', '│e\u{301}     │'] }),
            'MOB-TERM-01',
        );

        expect(receipt.result.lines[0]).toMatchObject({ bordersIntact: false, index: 0 });
        expect(receipt.result.status).toBe('fixture_blocked');
        expect(() =>
            verifyTerminalFixturePreflightReceipt({
                ...receipt,
                result: { ...receipt.result, errors: [], status: 'ready' },
            }),
        ).toThrow();
        expect(() =>
            verifyTerminalFixturePreflightReceipt({
                ...receipt,
                result: {
                    ...receipt.result,
                    lines: [
                        { ...receipt.result.lines[0], width: 8 },
                        ...receipt.result.lines.slice(1),
                    ],
                },
            }),
        ).toThrow();
    });
});
