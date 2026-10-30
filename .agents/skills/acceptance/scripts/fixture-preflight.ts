import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import stringWidth from 'string-width';
import { z } from 'zod';

import { writeJsonAtomic } from '../../../../scripts/atomic-json';
import { isAcceptanceCaseId } from './runtime-state';

const SCRIPT_PATH = fileURLToPath(import.meta.url);

const generationSchema = z.string().regex(/^[\w-]{1,100}$/u);

const gridMarkerSchema = z.strictObject({
    columns: z.number().int().positive(),
    generation: generationSchema,
    rows: z.number().int().positive(),
});

const terminalFixtureSchema = z.strictObject({
    columns: z.number().int().positive(),
    domRowCount: z.number().int().nonnegative(),
    firstGridMarker: gridMarkerSchema,
    generation: generationSchema,
    lines: z.array(z.string()),
    rows: z.number().int().positive(),
});

export type TerminalFixture = z.infer<typeof terminalFixtureSchema>;

const terminalFixtureSummarySchema = z.strictObject({
    columns: z.number().int().positive(),
    domRowCount: z.number().int().nonnegative(),
    firstGridMarker: gridMarkerSchema,
    generation: generationSchema,
    lineCount: z.number().int().nonnegative(),
    rows: z.number().int().positive(),
});

type TerminalFixtureSummary = z.infer<typeof terminalFixtureSummarySchema>;

export interface FixturePreflightResult {
    errors: Array<{ code: string; detail: string }>;
    lines: Array<{ bordersIntact: boolean; index: number; width: number }>;
    status: 'fixture_blocked' | 'ready';
}

const preflightErrorSchema = z.strictObject({
    code: z.enum([
        'fixture-row-count',
        'fixture-dom-row-count',
        'fixture-grid-marker',
        'fixture-border',
        'fixture-cell-width',
    ]),
    detail: z.string(),
});
const preflightLineSchema = z.strictObject({
    bordersIntact: z.boolean(),
    index: z.number().int().nonnegative(),
    width: z.number().int().nonnegative(),
});
const preflightResultSchema = z.strictObject({
    errors: z.array(preflightErrorSchema),
    lines: z.array(preflightLineSchema),
    status: z.enum(['fixture_blocked', 'ready']),
});

const terminalFixturePreflightReceiptSchema = z.strictObject({
    caseId: z.string().refine(isAcceptanceCaseId, {
        message: 'Acceptance case id must use ASCII letters, numbers, and hyphens',
    }),
    fixture: terminalFixtureSummarySchema,
    kind: z.literal('terminal-fixture-preflight'),
    launchId: z.string().min(1).optional(),
    result: preflightResultSchema,
    schemaVersion: z.literal(2),
    sourceCommit: z
        .string()
        .regex(/^[0-9a-f]{7,64}$/iu)
        .optional(),
});

export type TerminalFixturePreflightReceipt = z.infer<typeof terminalFixturePreflightReceiptSchema>;

function summarizeTerminalFixture(fixture: TerminalFixture): TerminalFixtureSummary {
    const { lines, ...summary } = fixture;
    return { ...summary, lineCount: lines.length };
}

function evaluateTerminalFixtureGrid(
    fixture: TerminalFixtureSummary,
    measurements: FixturePreflightResult['lines'],
): FixturePreflightResult {
    const errors: FixturePreflightResult['errors'] = [];

    if (fixture.lineCount !== fixture.rows) {
        errors.push({
            code: 'fixture-row-count',
            detail: `Fixture has ${fixture.lineCount} lines for ${fixture.rows} rows`,
        });
    }
    if (fixture.domRowCount !== fixture.rows) {
        errors.push({
            code: 'fixture-dom-row-count',
            detail: `DOM has ${fixture.domRowCount} rows for a ${fixture.rows}-row grid`,
        });
    }
    if (
        fixture.firstGridMarker.columns !== fixture.columns ||
        fixture.firstGridMarker.rows !== fixture.rows ||
        fixture.firstGridMarker.generation !== fixture.generation
    ) {
        errors.push({
            code: 'fixture-grid-marker',
            detail: 'The first observable grid marker does not match this fixture generation',
        });
    }

    for (const { bordersIntact, index, width } of measurements) {
        if (!bordersIntact) {
            errors.push({
                code: 'fixture-border',
                detail: `Line ${index + 1} does not preserve both vertical borders`,
            });
        }
        if (width !== fixture.columns) {
            errors.push({
                code: 'fixture-cell-width',
                detail: `Line ${index + 1} occupies ${width} cells instead of ${fixture.columns}`,
            });
        }
    }

    return { errors, lines: measurements, status: errors.length > 0 ? 'fixture_blocked' : 'ready' };
}

/**
 * Validates the rendered fixture before recording starts. `string-width` follows terminal cell semantics for CJK,
 * emoji, and combining characters, so UTF-16 length can never certify a grid.
 */
export function preflightTerminalFixture(input: TerminalFixture): FixturePreflightResult {
    const fixture = terminalFixtureSchema.parse(input);
    const measurements = fixture.lines.map((line, index) => ({
        bordersIntact: line.startsWith('│') && line.endsWith('│'),
        index,
        width: stringWidth(line),
    }));
    return evaluateTerminalFixtureGrid(summarizeTerminalFixture(fixture), measurements);
}

/**
 * Rejects raw Terminal rows and inconsistent derived measurements before a receipt can be cited or used for capture.
 */
export function verifyTerminalFixturePreflightReceipt(
    raw: unknown,
): TerminalFixturePreflightReceipt {
    const receipt = terminalFixturePreflightReceiptSchema.parse(raw);
    if (
        receipt.result.lines.length !== receipt.fixture.lineCount ||
        receipt.result.lines.some(({ index }, position) => index !== position)
    ) {
        throw new Error('Fixture preflight receipt does not match its observed fixture');
    }
    const expected = evaluateTerminalFixtureGrid(receipt.fixture, receipt.result.lines);
    if (JSON.stringify(receipt.result) !== JSON.stringify(expected)) {
        throw new Error('Fixture preflight receipt does not match its observed fixture');
    }
    return receipt;
}

function help(): string {
    return `Validate a Terminal Acceptance fixture before evidence capture

Usage:
  bun run .agents/skills/acceptance/scripts/fixture-preflight.ts --input fixture.json --case-id ID [--output receipt.json]`;
}

export function createTerminalFixturePreflightReceipt(
    fixture: TerminalFixture,
    caseId = 'unscoped',
    identity?: { launchId: string; sourceCommit: string },
): TerminalFixturePreflightReceipt {
    const observed = terminalFixtureSchema.parse(fixture);
    return terminalFixturePreflightReceiptSchema.parse({
        caseId,
        fixture: summarizeTerminalFixture(observed),
        kind: 'terminal-fixture-preflight',
        ...identity,
        result: preflightTerminalFixture(observed),
        schemaVersion: 2,
    });
}

async function main(argv: string[]): Promise<void> {
    if (argv.includes('--help')) {
        console.log(help());
        return;
    }
    const inputIndex = argv.indexOf('--input');
    const input = inputIndex !== -1 ? argv[inputIndex + 1] : undefined;
    if (!input || input.startsWith('--')) throw new Error('Missing --input');
    const caseIdIndex = argv.indexOf('--case-id');
    const caseId = caseIdIndex !== -1 ? argv[caseIdIndex + 1] : undefined;
    if (!caseId || caseId.startsWith('--')) throw new Error('Missing --case-id');
    const outputIndex = argv.indexOf('--output');
    const output = outputIndex !== -1 ? argv[outputIndex + 1] : undefined;
    if (outputIndex !== -1 && (!output || output.startsWith('--'))) {
        throw new Error('Missing --output value');
    }
    const path = isAbsolute(input) ? input : resolve(input);
    const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
    const receipt = createTerminalFixturePreflightReceipt(terminalFixtureSchema.parse(raw), caseId);
    if (output) {
        const outputPath = isAbsolute(output) ? output : resolve(output);
        await writeJsonAtomic(outputPath, receipt);
    }
    console.log(JSON.stringify(receipt, null, 2));
    if (receipt.result.status === 'fixture_blocked') process.exitCode = 2;
}

const invokedPath =
    process.argv[1] && (isAbsolute(process.argv[1]) ? process.argv[1] : resolve(process.argv[1]));
if (invokedPath === SCRIPT_PATH) {
    try {
        await main(process.argv.slice(2));
    } catch (error: unknown) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
