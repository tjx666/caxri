#!/usr/bin/env bun

/**
 * Keeps the em-dash (U+2014) out of every tracked text file. Prose here, in docs, skills, comments, and UI copy alike,
 * uses a colon, semicolon, comma, period, or parentheses instead: an em-dash joins two clauses without saying how they
 * relate, and agents reproduce whatever punctuation dominates neighboring text, so one exemplar spreads.
 *
 * Exceptions, deliberately narrow:
 *
 * - The exact string literal `'—'` (or its double-quoted or template form) stays allowed in code. It is the empty-value
 *   placeholder glyph in tabular UI, a typographic symbol rather than punctuation.
 * - Code that genuinely needs the character (a Unicode-width fixture, a parser input) writes the `\u2014` escape, which
 *   this check does not match.
 * - Vendored third-party content under `licenses/` and `tools/` is not ours to rewrite.
 *
 * Scans the whole tracked tree with `git grep` rather than a diff, so it needs no merge base and runs in well under a
 * second on CI's shallow checkout.
 */

import { resolve } from 'node:path';
import process from 'node:process';

import { execFileAsync } from './exec';

const projectRoot = resolve(import.meta.dirname, '..');
const EM_DASH = '\u{2014}';

const EXCLUDED_PATHSPECS = [':(exclude)licenses/**', ':(exclude)tools/**'];

const PLACEHOLDER_LITERAL = new RegExp(String.raw`(['"\x60])${EM_DASH}\1`, 'g');

interface EmDashFinding {
    column: number;
    line: number;
    path: string;
    text: string;
}

/**
 * Returns the findings in one `git grep -n` output line, ignoring the allowed placeholder literal. Exported for tests.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/em-dash-check.test.ts
export function findEmDashes(grepLine: string): EmDashFinding | undefined {
    const match = /^(.+?):(\d+):(.*)$/s.exec(grepLine);
    if (!match) return undefined;
    const [, path, lineNumber, text] = match;
    const column = text
        .replaceAll(PLACEHOLDER_LITERAL, (literal) => ' '.repeat(literal.length))
        .indexOf(EM_DASH);
    if (column === -1) return undefined;
    return { column: column + 1, line: Number(lineNumber), path, text: text.trim() };
}

/**
 * Lists every disallowed em-dash in the files Git tracks under `cwd`. Exported for tests.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/em-dash-check.test.ts
export async function collectEmDashFindings(cwd: string): Promise<EmDashFinding[]> {
    let stdout: string;
    try {
        ({ stdout } = await execFileAsync(
            'git',
            ['grep', '-n', '-I', '--fixed-strings', EM_DASH, '--', '.', ...EXCLUDED_PATHSPECS],
            { cwd, maxBuffer: 16 * 1024 * 1024 },
        ));
    } catch (error) {
        // `git grep` exits 1 when nothing matches, which is the passing case.
        if ((error as { code?: unknown }).code === 1) return [];
        throw error;
    }
    return stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => findEmDashes(line))
        .filter((finding): finding is EmDashFinding => finding !== undefined);
}

async function main(): Promise<void> {
    const findings = await collectEmDashFindings(projectRoot);
    if (findings.length === 0) {
        console.log('em-dash-check: no em-dashes found.');
        return;
    }
    for (const finding of findings) {
        console.error(`${finding.path}:${finding.line}:${finding.column}: ${finding.text}`);
    }
    console.error(
        `\nem-dash-check: ${findings.length} line(s) contain an em-dash (U+2014). Rewrite each sentence with a colon, ` +
            'semicolon, comma, period, or parentheses; see scripts/em-dash-check.ts for the allowed exceptions.',
    );
    process.exitCode = 1;
}

if (import.meta.main) {
    await main();
}
