#!/usr/bin/env bun

/**
 * Keeps the em-dash (U+2014) out of contributor prose: docs, skills, and other non-code text files, plus comments in
 * code. That prose uses a colon, semicolon, comma, period, or parentheses instead: an em-dash joins two clauses without
 * saying how they relate, and agents reproduce whatever punctuation dominates neighboring text, so one exemplar
 * spreads.
 *
 * Product copy is out of scope. In code files (see `CODE_EXTENSIONS`) only comment text is checked, so UI strings, JSX
 * text, Agent prompts, and the tests asserting them keep whatever punctuation the product wording calls for. The
 * comment detection is a line heuristic: the em-dash counts when it follows a `//`, `/*`, `{/*`, or `<!--` opener on
 * the same line, or when the line itself starts with one of those or with a JSDoc `*` continuation.
 *
 * Vendored third-party content under `licenses/` and `tools/` is not ours to rewrite.
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

/**
 * Source files where only comment text counts as contributor prose.
 */
const CODE_EXTENSIONS = new Set([
    'cjs',
    'css',
    'cts',
    'html',
    'js',
    'jsx',
    'mjs',
    'mts',
    'ts',
    'tsx',
]);

/**
 * A line that is itself a comment body: `// …`, `/* …`, `{/* …`, `<!-- …`, or a JSDoc `* …` continuation.
 */
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\{\/\*|<!--|\*(?:\s|$))/;

/**
 * A trailing comment opener preceded by whitespace, so `https://` inside a string does not count.
 */
const TRAILING_COMMENT_OPENER = /(?:^|\s)(?:\/\/|\/\*|\{\/\*|<!--)/g;

function isCodePath(path: string): boolean {
    const extension = /\.([^./]+)$/.exec(path)?.[1];
    return extension !== undefined && CODE_EXTENSIONS.has(extension);
}

/**
 * Returns the 0-based index of the first em-dash that sits in comment text, or -1.
 */
function commentEmDashIndex(text: string): number {
    if (COMMENT_LINE.test(text)) return text.indexOf(EM_DASH);
    for (const opener of text.matchAll(TRAILING_COMMENT_OPENER)) {
        const index = text.indexOf(EM_DASH, opener.index);
        if (index !== -1) return index;
    }
    return -1;
}

interface EmDashFinding {
    column: number;
    line: number;
    path: string;
    text: string;
}

/**
 * Returns the finding in one `git grep -n` output line, ignoring em-dashes outside comments in code files. Exported for
 * tests.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/em-dash-check.test.ts
export function findEmDashes(grepLine: string): EmDashFinding | undefined {
    const match = /^(.+?):(\d+):(.*)$/s.exec(grepLine);
    if (!match) return undefined;
    const [, path, lineNumber, text] = match;
    const column = isCodePath(path) ? commentEmDashIndex(text) : text.indexOf(EM_DASH);
    if (column === -1) return undefined;
    return { column: column + 1, line: Number(lineNumber), path, text: text.trim() };
}

/**
 * Lists every disallowed em-dash in the files Git tracks under `cwd`. With `staged` (the pre-commit hook's `--staged`
 * mode) it reads the index instead of the working tree, so an unstaged edit can neither block nor pass a commit that
 * leaves it out. Exported for tests.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/em-dash-check.test.ts
export async function collectEmDashFindings(
    cwd: string,
    { staged = false }: { staged?: boolean } = {},
): Promise<EmDashFinding[]> {
    let stdout: string;
    try {
        ({ stdout } = await execFileAsync(
            'git',
            [
                'grep',
                ...(staged ? ['--cached'] : []),
                '-n',
                '-I',
                '--fixed-strings',
                EM_DASH,
                '--',
                '.',
                ...EXCLUDED_PATHSPECS,
            ],
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
    const findings = await collectEmDashFindings(projectRoot, {
        staged: process.argv.includes('--staged'),
    });
    if (findings.length === 0) {
        console.log('em-dash-check: no em-dashes found.');
        return;
    }
    for (const finding of findings) {
        console.error(`${finding.path}:${finding.line}:${finding.column}: ${finding.text}`);
    }
    console.error(
        `\nem-dash-check: ${findings.length} line(s) contain an em-dash (U+2014). Rewrite each sentence with a colon, ` +
            'semicolon, comma, period, or parentheses; see scripts/em-dash-check.ts for what the check covers.',
    );
    process.exitCode = 1;
}

if (import.meta.main) {
    await main();
}
