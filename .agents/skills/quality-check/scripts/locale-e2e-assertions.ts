import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import ts from 'typescript';

import { walkMatchingFiles } from './source-imports';

const execFileAsync = promisify(execFile);
const EN_LOCALE_FILE = /^apps\/desktop\/src\/renderer\/src\/i18n\/locales\/en\/[^/]+\.ts$/;
/**
 * Shorter fragments (a word or two) match unrelated spec text too often to be a useful warning.
 */
const MIN_FRAGMENT_LENGTH = 12;

export interface StaleLocaleCopyWarning {
    /**
     * Line-qualified spec location, `e2e/example.e2e.ts:42`.
     */
    location: string;
    /**
     * The static part of the old English copy that the spec still asserts.
     */
    fragment: string;
}

/**
 * Collects `'key': 'literal'` entries; interpolated or computed values are skipped.
 */
function extractLocaleEntries(source: string): Map<string, string> {
    const entries = new Map<string, string>();
    const file = ts.createSourceFile('locale.ts', source, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
        if (
            ts.isPropertyAssignment(node) &&
            (ts.isStringLiteral(node.name) || ts.isIdentifier(node.name)) &&
            (ts.isStringLiteral(node.initializer) ||
                ts.isNoSubstitutionTemplateLiteral(node.initializer))
        ) {
            entries.set(node.name.text, node.initializer.text);
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    return entries;
}

/**
 * Old copy that no longer exists verbatim: the value of every key that was edited or removed.
 */
export function staleLocaleValues(before: string, after: string): string[] {
    const next = extractLocaleEntries(after);
    return [...extractLocaleEntries(before)]
        .filter(([key, value]) => next.get(key) !== value)
        .map(([, value]) => value);
}

/**
 * Reduces a value to the longest static segment between `{{placeholder}}` interpolations, because a spec asserts the
 * rendered text and can only ever contain that static part. Edge punctuation is dropped because a spec regex often
 * stops before it (`/^Weekly limit on track to run out/u` for "... run out: {{percent}}% left"). Returns undefined when
 * it is too short to match reliably.
 */
export function staticFragment(value: string): string | undefined {
    const longest = value
        .split(/\{\{[^}]*\}\}/)
        .map((segment) => segment.replaceAll(/^[\s:;,.\-]+|[\s:;,.\-]+$/gu, ''))
        .toSorted((a, b) => b.length - a.length)[0];
    return longest && longest.length >= MIN_FRAGMENT_LENGTH ? longest : undefined;
}

async function gitShowOrEmpty(root: string, reference: string, path: string): Promise<string> {
    try {
        const { stdout } = await execFileAsync('git', ['show', `${reference}:${path}`], {
            cwd: root,
            encoding: 'utf8',
            maxBuffer: 16 * 1024 * 1024,
        });
        return stdout;
    } catch {
        // A locale file that did not exist at the base has no old copy to go stale.
        return '';
    }
}

async function readOrEmpty(path: string): Promise<string> {
    try {
        return await readFile(path, 'utf8');
    } catch {
        return '';
    }
}

/**
 * Advisory only: finds E2E specs that still assert English locale copy the change edited or removed. A spec that
 * asserts rendered text is invisible to import-based discovery, so a reworded string used to fail only in CI. `baseRef`
 * is the revision the old copy is read from (the `origin/main` merge base, or `HEAD` for `--staged`).
 */
export async function staleLocaleCopyWarnings(
    root: string,
    changedFiles: readonly string[],
    baseReference: string,
): Promise<StaleLocaleCopyWarning[]> {
    const localeFiles = changedFiles.filter((file) => EN_LOCALE_FILE.test(file));
    if (localeFiles.length === 0) return [];
    const staleValues = await Promise.all(
        localeFiles.map(async (file) => {
            const [before, after] = await Promise.all([
                gitShowOrEmpty(root, baseReference, file),
                readOrEmpty(join(root, file)),
            ]);
            return staleLocaleValues(before, after);
        }),
    );
    const fragments = [
        ...new Set(staleValues.flat().flatMap((value) => staticFragment(value) ?? [])),
    ];
    if (fragments.length === 0) return [];

    const specs = (await walkMatchingFiles(root, 'e2e', /\.ts$/)).toSorted((a, b) =>
        a.localeCompare(b),
    );
    const specLines = await Promise.all(
        specs.map(async (spec) => ({
            spec,
            lines: (await readFile(join(root, spec), 'utf8')).split('\n'),
        })),
    );
    const warnings: StaleLocaleCopyWarning[] = [];
    for (const { spec, lines } of specLines) {
        for (const [index, line] of lines.entries()) {
            // Specs escape quotes inside single-quoted literals; compare on the unescaped text.
            const text = line.replaceAll(String.raw`\'`, "'");
            const fragment = fragments.find((candidate) => text.includes(candidate));
            if (fragment) warnings.push({ location: `${spec}:${index + 1}`, fragment });
        }
    }
    return warnings;
}

function formatStaleLocaleCopyWarnings(warnings: readonly StaleLocaleCopyWarning[]): string {
    return `Stale English copy asserted by E2E (run explicitly):\n${warnings
        .map(({ location, fragment }) => `  ${location} "${fragment}"`)
        .join('\n')}`;
}

/**
 * Prints the advisory warning for a `check` run; reads old copy from `HEAD` when staged, else the `origin/main` merge
 * base.
 */
export async function reportStaleLocaleCopy(
    root: string,
    changedFiles: readonly string[],
    isStaged: boolean,
): Promise<void> {
    if (changedFiles.every((file) => !EN_LOCALE_FILE.test(file))) return;
    const baseReference = isStaged
        ? 'HEAD'
        : (
              await execFileAsync('git', ['merge-base', 'origin/main', 'HEAD'], {
                  cwd: root,
                  encoding: 'utf8',
              })
          ).stdout.trim();
    const warnings = await staleLocaleCopyWarnings(root, changedFiles, baseReference);
    if (warnings.length > 0) console.log(formatStaleLocaleCopyWarnings(warnings));
}
