#!/usr/bin/env bun

/**
 * Ratchets source file size against `origin/main` so this repository's ESLint `max-lines` ceiling (800, see
 * `eslint.config.ts`) is a hard stop, not the default growth path. A file already near that ceiling that keeps growing
 * is a maintenance-debt signal well before it trips the hard limit; this check flags that growth and asks for a split
 * by responsibility instead of a compress-to-fit edit.
 *
 * Compares each changed source file's working-tree line count against its line count at the merge-base with
 * `origin/main` (overridable with `--base <ref>`; CI supplies its own base, see `resolveRatchetBase`), using Git rename
 * detection so a pure move never reads as new growth:
 *
 * - An existing file already at or above the threshold that grew further fails.
 * - A new path (including a rename target whose pre-rename size was below the threshold) that lands at or above the
 *   threshold fails: a rename that also grows past the ceiling is exactly the growth this check exists to catch.
 * - Shrinking, or growing while staying below the threshold, passes -- even a file still above the threshold, since this
 *   is a growth ratchet, not a restatement of ESLint's absolute ceiling.
 */

import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import process from 'node:process';

import { execFileAsync } from './exec';

const projectRoot = resolve(import.meta.dirname, '..');
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * Below ESLint's hard `max-lines: 800` ceiling (see `eslint.config.ts`) on purpose: this is a ratchet against growth
 * approaching that ceiling, not a restatement of it. A file already this large that keeps growing is flagged well
 * before it can trip the hard limit in the same change.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/source-size-ratchet.test.ts
export const RATCHET_LINE_THRESHOLD = 600;

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/source-size-ratchet.test.ts
export const RATCHET_SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js'];

/**
 * Root directories this ratchet inspects, matching its owning task's scope. `apps/`, `packages/`, and `extensions/`
 * hold every shipped workspace; `scripts/` and `e2e/` hold repository tooling and Playwright coverage;
 * `.agents/skills/` holds the scripts an owning skill ships beside itself.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/source-size-ratchet.test.ts
export const RATCHET_SOURCE_ROOTS = [
    'apps/',
    'packages/',
    'extensions/',
    'scripts/',
    'e2e/',
    '.agents/skills/',
];

/**
 * Paths under `RATCHET_SOURCE_ROOTS` this ratchet exempts, for two distinct reasons:
 *
 * - Generated or vendored paths ESLint's own `globalIgnores` (`eslint.config.ts`) also excludes from lint entirely,
 *   narrowed to the extensions and roots this ratchet actually scans. This mirrors that subset as a static list instead
 *   of importing `eslint.config.ts` directly: that file is not owned by this script, its ignore list mixes in
 *   extensions and roots this ratchet never scans anyway (e.g. `**\/*.{sh,swift}`, `competitors/**`, which sit outside
 *   `RATCHET_SOURCE_ROOTS`), and a static list avoids paying ESLint's module-graph load cost on every ratchet run.
 *   Re-check this subset by hand against `eslint.config.ts`'s `globalIgnores` array when either changes.
 * - Mechanically generated data manifests that ESLint still lints (they are ordinary, Prettier-formatted TypeScript), but
 *   whose growth this ratchet's own remedy -- "split it by responsibility" -- cannot act on: the whole file is one
 *   generated `Record<string, string>` export, regenerated in full by its owning build script from a curated name list.
 *   Its size tracks that list's length, not hand-maintained complexity.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/source-size-ratchet.test.ts
export const RATCHET_IGNORE_PATH_PREFIXES = [
    // Expo prebuild output: generated native code, not authored source.
    'apps/mobile/android/',
    'apps/mobile/ios/',
    // Negative lint fixtures: deliberately malformed, never meant to satisfy this or any other size guard.
    'scripts/fixtures/eslint/',
    'scripts/fixtures/markdown/',
    // Generated file-icon manifest: regenerated in full by `apps/mobile/scripts/build-file-icons.ts` from a curated
    // name list; "split by responsibility" does not apply to a single generated lookup table.
    'apps/mobile/src/features/panels/file-icons.generated.ts',
    // Bundled/vendored design-prototype runtime assets `build-runtime.ts` writes and caches.
    '.agents/skills/design-prototype/assets/',
];

/**
 * Whether a repo-relative path is in scope for the ratchet at all, independent of its line counts.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/source-size-ratchet.test.ts
export function isRatchetCandidatePath(path: string): boolean {
    if (!RATCHET_SOURCE_EXTENSIONS.includes(extname(path))) return false;
    if (RATCHET_SOURCE_ROOTS.every((root) => !path.startsWith(root))) return false;
    return RATCHET_IGNORE_PATH_PREFIXES.every((prefix) => !path.startsWith(prefix));
}

/**
 * Counts lines the way a contributor would, independent of a trailing newline: `"a\nb\n"` and `"a\nb"` are both 2
 * lines. A plain `content.split('\n').length` would count the artifact of a trailing newline as an extra empty line.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/source-size-ratchet.test.ts
export function countLines(content: string): number {
    if (content === '') return 0;
    const withoutTrailingNewline = content.endsWith('\n') ? content.slice(0, -1) : content;
    return withoutTrailingNewline.split('\n').length;
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/source-size-ratchet.test.ts
export interface RatchetCandidate {
    baseLines: number;
    headLines: number;
    /**
     * The renamed-from path, when Git detected this candidate as a rename target. Informational only.
     */
    oldPath?: string;
    path: string;
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/source-size-ratchet.test.ts
export interface RatchetViolation {
    baseLines: number;
    headLines: number;
    message: string;
    path: string;
}

/**
 * Pure evaluation: a candidate fails when its working-tree line count is at or above the threshold _and_ it grew past
 * its merge-base line count (0 for a genuinely new path, or for a rename target this treats the pre-rename path's line
 * count as the base). Shrinking never fails, even while still above the threshold, and a pure rename with no content
 * growth (`headLines === baseLines`) never fails either.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/source-size-ratchet.test.ts
export function evaluateRatchet(
    candidates: readonly RatchetCandidate[],
    threshold: number = RATCHET_LINE_THRESHOLD,
): RatchetViolation[] {
    const violations: RatchetViolation[] = [];
    for (const candidate of candidates) {
        if (candidate.headLines < threshold) continue;
        if (candidate.headLines <= candidate.baseLines) continue;
        const origin =
            candidate.oldPath && candidate.oldPath !== candidate.path
                ? ` (renamed from ${candidate.oldPath}, ${candidate.baseLines} line(s) there)`
                : ` (was ${candidate.baseLines} line(s))`;
        violations.push({
            baseLines: candidate.baseLines,
            headLines: candidate.headLines,
            message:
                `${candidate.path} is now ${candidate.headLines} line(s)${origin}, at or above the ` +
                `${threshold}-line source-size ratchet. Split it by responsibility instead of compressing it to ` +
                'fit -- see the source-layout skill for where the split pieces belong.',
            path: candidate.path,
        });
    }
    return violations;
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/source-size-ratchet.test.ts
export interface GitDiffRecord {
    oldPath?: string;
    path: string;
    status: string;
}

/**
 * Parses `git diff --name-status -z` output into structured records. With `-z`, every field (including the last) is
 * NUL-terminated, so splitting on `\0` and dropping empty trailing elements yields a flat token stream this walks
 * sequentially: a rename/copy status (`R100`, `C075`, ...) is followed by two path fields (old, new); every other
 * status is followed by one.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/source-size-ratchet.test.ts
export function parseNameStatusRecords(raw: string): GitDiffRecord[] {
    const tokens = raw.split('\0').filter((token) => token.length > 0);
    const records: GitDiffRecord[] = [];
    let index = 0;
    while (index < tokens.length) {
        // The while condition already guarantees this index is in bounds, so `status` is never undefined here.
        const status = tokens[index];
        index += 1;
        if (status.startsWith('R') || status.startsWith('C')) {
            const oldPath = tokens[index];
            const path = tokens[index + 1];
            index += 2;
            // A malformed/truncated diff stream can genuinely index past `tokens.length` here (undefined at
            // runtime); TS's array-index type doesn't reflect that without `noUncheckedIndexedAccess`, which is not
            // enabled for scripts/**.
            // oxlint-disable-next-line typescript/no-unnecessary-condition -- see comment above
            if (oldPath === undefined || path === undefined) break;
            records.push({ oldPath, path, status });
        } else {
            const path = tokens[index];
            index += 1;
            // oxlint-disable-next-line typescript/no-unnecessary-condition -- see comment in the rename branch above
            if (path === undefined) break;
            records.push({ path, status });
        }
    }
    return records;
}

async function runGit(root: string, arguments_: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', arguments_, {
        cwd: root,
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
    });
    return stdout;
}

/**
 * Reads a path's content at a given revision, or `''` when it did not exist there (a genuinely new path, or a rename
 * source outside this diff). Git's own error path (`fatal: path '...' does not exist in '<rev>'`, non-zero exit) is the
 * only failure mode this needs to distinguish from a real I/O problem, and treating any failure as "did not exist yet"
 * is the fail-open direction that matches the ratchet's own semantics: a path with no prior content always counts as a
 * 0-line base.
 */
async function readRevisionFile(root: string, revision: string, path: string): Promise<string> {
    try {
        return await runGit(root, ['show', `${revision}:${path}`]);
    } catch {
        return '';
    }
}

async function readWorkingTreeFile(root: string, path: string): Promise<string | undefined> {
    try {
        return await readFile(resolve(root, path), 'utf8');
    } catch {
        return undefined;
    }
}

/**
 * Collects every in-scope changed source file (tracked and untracked) as a ratchet candidate, pairing its current
 * working-tree content with its content at `base`. Tracked changes go through `git diff --find-renames` so a rename
 * target's base content comes from its pre-rename path, not an empty string; untracked files always get a 0-line base
 * since they cannot exist at any prior revision.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/source-size-ratchet.test.ts
export async function collectRatchetCandidates(
    root: string,
    base: string,
): Promise<RatchetCandidate[]> {
    const pathspecs = RATCHET_SOURCE_ROOTS;
    const [diffOutput, untrackedOutput] = await Promise.all([
        runGit(root, ['diff', '--find-renames', '--name-status', '-z', base, '--', ...pathspecs]),
        runGit(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...pathspecs]),
    ]);

    const records = parseNameStatusRecords(diffOutput).filter((record) => record.status !== 'D');
    const untrackedPaths = untrackedOutput.split('\0').filter((token) => token.length > 0);

    const seen = new Set<string>();
    const trackedCandidates = await Promise.all(
        records
            .filter((record) => isRatchetCandidatePath(record.path) && !seen.has(record.path))
            .map(async (record) => {
                seen.add(record.path);
                const headContent = await readWorkingTreeFile(root, record.path);
                // Deleted from the working tree since the diff was computed (e.g. a later manual `rm`); nothing to
                // measure or flag.
                if (headContent === undefined) return;
                const baseContent = await readRevisionFile(
                    root,
                    base,
                    record.oldPath ?? record.path,
                );
                const candidate: RatchetCandidate = {
                    baseLines: countLines(baseContent),
                    headLines: countLines(headContent),
                    path: record.path,
                };
                if (record.oldPath) candidate.oldPath = record.oldPath;
                return candidate;
            }),
    );

    const untrackedCandidates = await Promise.all(
        untrackedPaths
            .filter((path) => isRatchetCandidatePath(path) && !seen.has(path))
            .map(async (path) => {
                seen.add(path);
                const headContent = await readWorkingTreeFile(root, path);
                if (headContent === undefined) return;
                return { baseLines: 0, headLines: countLines(headContent), path };
            }),
    );

    return [...trackedCandidates, ...untrackedCandidates].filter(
        (candidate): candidate is RatchetCandidate => candidate !== undefined,
    );
}

function parseBaseArgument(argv: readonly string[]): string | undefined {
    const index = argv.indexOf('--base');
    return index === -1 ? undefined : argv[index + 1];
}

/**
 * Picks the revision to compare against: `--base`, then the CI-provided base, then the merge-base with `origin/main`.
 *
 * CI's full platform checks run in a synthetic-merge checkout that has no `origin/main` ref; they receive the fetched
 * base revision through `CAXRI_REACT_DOCTOR_BASE` instead (written by `scripts/ci-checks-worktree.ts`, and read the
 * same way by `scripts/doctor-changed.ts`), so every changed-scope gate compares against one CI-provided base. Returns
 * `null` for GitHub's all-zero `before` SHA on an initial branch push, which has no base to compare against.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/source-size-ratchet.test.ts
export async function resolveRatchetBase(
    argv: readonly string[],
    environment: NodeJS.ProcessEnv,
    mergeBaseWithMain: () => Promise<string>,
): Promise<string | null> {
    const explicitBase = parseBaseArgument(argv);
    if (explicitBase) return explicitBase;
    const ciBase = environment.CAXRI_REACT_DOCTOR_BASE?.trim();
    if (ciBase) return /^0+$/.test(ciBase) ? null : ciBase;
    return mergeBaseWithMain();
}

async function main(): Promise<void> {
    const base = await resolveRatchetBase(process.argv.slice(2), process.env, async () =>
        (await runGit(projectRoot, ['merge-base', 'origin/main', 'HEAD'])).trim(),
    );
    if (base === null) {
        console.log(
            'source-size-ratchet: skipped, this push has no base revision to compare against.',
        );
        return;
    }

    const candidates = await collectRatchetCandidates(projectRoot, base);
    const violations = evaluateRatchet(candidates);

    if (violations.length === 0) {
        console.log(
            `source-size-ratchet: ${candidates.length} changed source file(s) checked against ${base}, none grew ` +
                `past ${RATCHET_LINE_THRESHOLD} lines.`,
        );
        return;
    }

    console.error(
        `source-size-ratchet: ${violations.length} file(s) grew past the ${RATCHET_LINE_THRESHOLD}-line ratchet:\n`,
    );
    for (const violation of violations) console.error(`  - ${violation.message}`);
    process.exitCode = 1;
}

if (import.meta.main) await main();
