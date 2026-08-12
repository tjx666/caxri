#!/usr/bin/env bun

import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import stringWidth from 'string-width';
import { z } from 'zod';

const SCRIPT_PATH = fileURLToPath(import.meta.url);

const gridMarkerSchema = z.object({
    columns: z.number().int().positive(),
    generation: z.string().min(1),
    rows: z.number().int().positive(),
});

export const terminalFixtureSchema = z.object({
    columns: z.number().int().positive(),
    domRowCount: z.number().int().nonnegative(),
    firstGridMarker: gridMarkerSchema,
    generation: z.string().min(1),
    lines: z.array(z.string()),
    rows: z.number().int().positive(),
});

export type TerminalFixture = z.infer<typeof terminalFixtureSchema>;

export interface FixturePreflightResult {
    errors: Array<{ code: string; detail: string }>;
    lines: Array<{ index: number; width: number }>;
    status: 'fixture_blocked' | 'ready';
}

/**
 * Validates the rendered fixture before recording starts. `string-width` follows terminal cell
 * semantics for CJK, emoji, and combining characters, so UTF-16 length can never certify a grid.
 */
export function preflightTerminalFixture(input: TerminalFixture): FixturePreflightResult {
    const fixture = terminalFixtureSchema.parse(input);
    const errors: FixturePreflightResult['errors'] = [];
    const measurements = fixture.lines.map((line, index) => ({ index, width: stringWidth(line) }));

    if (fixture.lines.length !== fixture.rows) {
        errors.push({
            code: 'fixture-row-count',
            detail: `Fixture has ${fixture.lines.length} lines for ${fixture.rows} rows`,
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

    for (const { index, width } of measurements) {
        const line = fixture.lines[index];
        if (!line.startsWith('│') || !line.endsWith('│')) {
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

    return { errors, lines: measurements, status: errors.length ? 'fixture_blocked' : 'ready' };
}

function help(): string {
    return `Validate a Terminal Acceptance fixture before evidence capture

Usage:
  bun run .agents/skills/acceptance/scripts/fixture-preflight.ts --input fixture.json`;
}

async function main(argv: string[]): Promise<void> {
    if (argv.includes('--help')) {
        console.log(help());
        return;
    }
    const inputIndex = argv.indexOf('--input');
    const input = inputIndex >= 0 ? argv[inputIndex + 1] : undefined;
    if (!input || input.startsWith('--')) throw new Error('Missing --input');
    const path = isAbsolute(input) ? input : resolve(input);
    const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
    const result = preflightTerminalFixture(terminalFixtureSchema.parse(raw));
    console.log(JSON.stringify(result, null, 2));
    if (result.status === 'fixture_blocked') process.exitCode = 2;
}

const invokedPath =
    process.argv[1] && (isAbsolute(process.argv[1]) ? process.argv[1] : resolve(process.argv[1]));
if (invokedPath === SCRIPT_PATH) {
    void main(process.argv.slice(2)).catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
