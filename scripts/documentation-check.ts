/**
 * Validates the documentation contract defined by `.agents/skills/write-docs/SKILL.md`: closed-enum frontmatter on
 * every `docs/**\/*.md` file, `docs/README.md` index completeness, relative Markdown link targets and their `#heading`
 * anchors (same-document ones included), backticked repository paths, and backticked TypeScript source filenames
 * written without a repository root. `GLOSSARY.md` and `AGENTS.md` get link/path checks only: they carry no frontmatter
 * and are not part of the `docs/` index.
 *
 * Every filesystem existence check walks each path segment through `readdir` instead of `existsSync`, because macOS's
 * default case-insensitive-but-preserving filesystem would silently accept a stale-cased reference (e.g.
 * `docs/mobile/UPDATE.md` after the file became `update.md`) that a case-sensitive CI runner or a public GitHub reader
 * would not.
 */

import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';

import { parse as parseYaml } from 'yaml';

import {
    collectMarkdownAnchors,
    decodeFragment,
    extractBacktickedRepoPaths,
    extractBacktickedSourceFilenames,
    extractRelativeLinks,
    frozenLedgerEntryLines,
} from './documentation-references';
import { execFileAsync } from './exec';

export interface DocumentationCheckIssue {
    file: string;
    line: number;
    message: string;
}

export const DOC_KIND_VALUES = ['living', 'adr', 'historical'] as const;
export type DocumentKind = (typeof DOC_KIND_VALUES)[number];

export const DOC_STATUS_VALUES = [
    'current',
    'proposed',
    'accepted',
    'superseded',
    'historical',
] as const;
export type DocumentStatus = (typeof DOC_STATUS_VALUES)[number];

/**
 * Statuses whose whole point is to describe paths and decisions that may no longer exist.
 */
const SKIP_PATH_CHECK_STATUSES = new Set<string>(['historical', 'superseded']);

const DOCS_INDEX_RELATIVE_PATH = 'docs/README.md';
const ALWAYS_CHECKED_ROOT_FILES = ['GLOSSARY.md', 'AGENTS.md'];

export interface ParsedFrontmatter {
    kind?: string;
    status?: string;
}

/**
 * Splits a leading `---\n...\n---` YAML block from the rest of a Markdown file. `headerLines` is the number of physical
 * lines the frontmatter block (including its closing `---`) occupies, so callers can translate a line number found in
 * `body` back to the original file.
 */
export function splitFrontmatter(source: string): {
    body: string;
    frontmatter: ParsedFrontmatter | null;
    headerLines: number;
} {
    if (!source.startsWith('---\n')) return { body: source, frontmatter: null, headerLines: 0 };
    const closingMarkerIndex = source.indexOf('\n---', 4);
    if (closingMarkerIndex === -1) return { body: source, frontmatter: null, headerLines: 0 };
    const header = source.slice(0, closingMarkerIndex + 4);
    const yamlSource = source.slice(4, closingMarkerIndex);
    const afterHeader = source.slice(header.length);
    const body = afterHeader.startsWith('\n') ? afterHeader.slice(1) : afterHeader;
    const headerLines = header.split('\n').length;

    let parsed: unknown;
    try {
        parsed = parseYaml(yamlSource);
    } catch {
        return { body, frontmatter: null, headerLines };
    }
    if (typeof parsed !== 'object' || parsed === null)
        return { body, frontmatter: null, headerLines };
    const record = parsed as Record<string, unknown>;
    return {
        body,
        frontmatter: {
            kind: typeof record.kind === 'string' ? record.kind : undefined,
            status: typeof record.status === 'string' ? record.status : undefined,
        },
        headerLines,
    };
}

/**
 * `docs/**\/*.md` frontmatter must declare exactly `kind` and `status` from the closed enums.
 */
export function checkFrontmatter(relativePath: string, source: string): DocumentationCheckIssue[] {
    const { frontmatter } = splitFrontmatter(source);
    if (!frontmatter) {
        return [
            {
                file: relativePath,
                line: 1,
                message: 'missing required "kind"/"status" YAML frontmatter',
            },
        ];
    }
    const issues: DocumentationCheckIssue[] = [];
    if (!frontmatter.kind || !(DOC_KIND_VALUES as readonly string[]).includes(frontmatter.kind)) {
        issues.push({
            file: relativePath,
            line: 2,
            message: `invalid "kind": ${frontmatter.kind ?? '(missing)'}; expected one of ${DOC_KIND_VALUES.join(', ')}`,
        });
    }
    if (
        !frontmatter.status ||
        !(DOC_STATUS_VALUES as readonly string[]).includes(frontmatter.status)
    ) {
        issues.push({
            file: relativePath,
            line: 3,
            message: `invalid "status": ${frontmatter.status ?? '(missing)'}; expected one of ${DOC_STATUS_VALUES.join(', ')}`,
        });
    }
    return issues;
}

export function shouldSkipPathChecks(source: string): boolean {
    const { frontmatter } = splitFrontmatter(source);
    return Boolean(frontmatter?.status && SKIP_PATH_CHECK_STATUSES.has(frontmatter.status));
}

/**
 * Lists tracked plus untracked-but-not-ignored files, so a source file the current change adds resolves before it is
 * staged. Returns `null` outside a Git repository, where a bare filename has nothing to resolve against.
 */
export async function listRepoFiles(repoRoot: string): Promise<string[] | null> {
    try {
        const { stdout } = await execFileAsync(
            'git',
            ['ls-files', '--cached', '--others', '--exclude-standard'],
            { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 },
        );
        return stdout.split('\n').filter((line) => line.length > 0);
    } catch {
        return null;
    }
}

export function isSourceFilenameResolvable(repoFiles: readonly string[], suffix: string) {
    return repoFiles.some((file) => file === suffix || file.endsWith(`/${suffix}`));
}

/**
 * Walks every path segment through `readdir` so the check is case-sensitive regardless of the host filesystem.
 */
export async function isPathPresentCaseSensitive(
    repoRoot: string,
    relativePath: string,
): Promise<boolean> {
    const segments = relativePath
        .split('/')
        .filter((segment) => segment.length > 0 && segment !== '.');
    let current = repoRoot;
    for (const segment of segments) {
        if (segment === '..') {
            current = dirname(current);
            continue;
        }
        let entries: string[];
        try {
            // eslint-disable-next-line no-await-in-loop -- each segment's directory depends on the previous segment resolving first
            entries = await readdir(current);
        } catch {
            return false;
        }
        if (!entries.includes(segment)) return false;
        current = join(current, segment);
    }
    return true;
}

/**
 * Reports whether `git` itself would never track `relativePath` (e.g. `apps/server/dist/server`, an Android
 * `build/outputs/...` artifact). Docs legitimately cite where a build lands even though the artifact does not exist in
 * a clean checkout, and nested `.gitignore` files (like `apps/mobile/.gitignore`'s `android/`) are exactly what `git
 * check-ignore` already resolves correctly: re-deriving that logic by hand here is the kind of second copy that
 * drifts.
 */
export async function isGitIgnoredPath(repoRoot: string, relativePath: string): Promise<boolean> {
    try {
        await execFileAsync('git', ['check-ignore', '-q', relativePath], { cwd: repoRoot });
        return true; // exit 0: at least the given path is ignored
    } catch {
        // exit 1 means "not ignored"; any other failure (no git, repoRoot is not a repository)
        // fails closed by not suppressing the underlying existence issue.
        return false;
    }
}

async function isPathAcceptable(repoRoot: string, relativePath: string): Promise<boolean> {
    if (await isPathPresentCaseSensitive(repoRoot, relativePath)) return true;
    return isGitIgnoredPath(repoRoot, relativePath);
}

export interface CheckFileOptions {
    /**
     * Repository-relative, POSIX-style path (e.g. `docs/cli.md`).
     */
    relativePath: string;
    repoRoot: string;
    /**
     * Result of `listRepoFiles`, shared across files by `runDocumentationCheck`; listed on demand when omitted.
     */
    repoFiles?: readonly string[] | null;
    source: string;
}

async function readAnchors(
    repoRoot: string,
    relativePath: string,
): Promise<Set<string> | undefined> {
    try {
        return collectMarkdownAnchors(await readFile(join(repoRoot, relativePath), 'utf8'));
    } catch {
        // An acceptable-but-absent target (a gitignored path) has no anchors to compare against.
        return undefined;
    }
}

export async function checkLinksAndPaths({
    relativePath,
    repoRoot,
    repoFiles,
    source,
}: CheckFileOptions): Promise<DocumentationCheckIssue[]> {
    const issues: DocumentationCheckIssue[] = [];
    const relativeFileDirectory = dirname(relativePath);
    const frozenLines = frozenLedgerEntryLines(source);
    const anchorsByTarget = new Map<string, Set<string> | undefined>([
        [relativePath, collectMarkdownAnchors(source)],
    ]);

    for (const link of extractRelativeLinks(source)) {
        if (frozenLines.has(link.line)) continue;
        let targetRelativeToRepoRoot = relativePath;
        if (link.target !== '') {
            targetRelativeToRepoRoot = link.target.startsWith('/')
                ? link.target.slice(1)
                : relative(repoRoot, join(repoRoot, relativeFileDirectory, link.target));
            // eslint-disable-next-line no-await-in-loop -- a doc has few links; sequential keeps issues in document order
            if (!(await isPathAcceptable(repoRoot, targetRelativeToRepoRoot))) {
                issues.push({
                    file: relativePath,
                    line: link.line,
                    message: `broken relative link target: ${link.rawTarget}`,
                });
                continue;
            }
        }
        // Only Markdown has heading anchors; `#L42` on a source file is GitHub's line-link syntax.
        if (!link.fragment || !targetRelativeToRepoRoot.endsWith('.md')) continue;
        if (!anchorsByTarget.has(targetRelativeToRepoRoot)) {
            anchorsByTarget.set(
                targetRelativeToRepoRoot,
                // eslint-disable-next-line no-await-in-loop -- memoized per target; a doc links few distinct files
                await readAnchors(repoRoot, targetRelativeToRepoRoot),
            );
        }
        const anchors = anchorsByTarget.get(targetRelativeToRepoRoot);
        if (anchors && !anchors.has(decodeFragment(link.fragment))) {
            issues.push({
                file: relativePath,
                line: link.line,
                message: `broken link anchor: ${link.rawTarget}`,
            });
        }
    }

    if (!shouldSkipPathChecks(source)) {
        for (const token of extractBacktickedRepoPaths(source)) {
            if (frozenLines.has(token.line)) continue;
            // eslint-disable-next-line no-await-in-loop -- a doc has few citations; sequential keeps issues in document order
            if (!(await isPathAcceptable(repoRoot, token.path))) {
                issues.push({
                    file: relativePath,
                    line: token.line,
                    message: `backticked repository path does not exist: ${token.path}`,
                });
            }
        }

        const filenames = extractBacktickedSourceFilenames(source).filter(
            (token) => !frozenLines.has(token.line),
        );
        let files: readonly string[] | null = null;
        if (filenames.length > 0)
            files = repoFiles === undefined ? await listRepoFiles(repoRoot) : repoFiles;
        const unresolvedFilenames = files
            ? filenames.filter((token) => !isSourceFilenameResolvable(files, token.suffix))
            : [];
        for (const token of unresolvedFilenames) {
            issues.push({
                file: relativePath,
                line: token.line,
                message: `backticked source filename matches no repository file: ${token.suffix}`,
            });
        }
    }

    return issues;
}

/**
 * `docs/README.md` must list every `docs/**\/*.md` file exactly once, with no entry for a file that no longer exists.
 */
export function checkReadmeIndex(
    readmeSource: string,
    documentPathsRelativeToDocumentationDirectory: string[],
): DocumentationCheckIssue[] {
    const issues: DocumentationCheckIssue[] = [];
    for (const documentPath of documentPathsRelativeToDocumentationDirectory) {
        if (!readmeSource.includes(`](${documentPath})`)) {
            issues.push({
                file: DOCS_INDEX_RELATIVE_PATH,
                line: 1,
                message: `docs/README.md is missing an index entry for docs/${documentPath}`,
            });
        }
    }
    return issues;
}

export async function collectMarkdownFilesRecursive(
    absoluteDirectory: string,
    repoRoot: string,
): Promise<string[]> {
    const results: string[] = [];
    let entries: Dirent[];
    try {
        entries = await readdir(absoluteDirectory, { withFileTypes: true });
    } catch {
        return results;
    }
    for (const entry of entries) {
        const absolutePath = join(absoluteDirectory, entry.name);
        if (entry.isDirectory()) {
            // eslint-disable-next-line no-await-in-loop -- each subdirectory is walked in turn; the small docs tree does not need concurrency
            results.push(...(await collectMarkdownFilesRecursive(absolutePath, repoRoot)));
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
            results.push(relative(repoRoot, absolutePath).replaceAll('\\', '/'));
        }
    }
    return results;
}

export async function defaultCheckedFiles(repoRoot: string): Promise<string[]> {
    const documentFiles = (
        await collectMarkdownFilesRecursive(join(repoRoot, 'docs'), repoRoot)
    ).toSorted((a, b) => a.localeCompare(b));
    return [...documentFiles, ...ALWAYS_CHECKED_ROOT_FILES];
}

export async function checkDocumentationFile(
    repoRoot: string,
    relativePath: string,
    repoFiles?: readonly string[] | null,
): Promise<DocumentationCheckIssue[]> {
    const source = await readFile(join(repoRoot, relativePath), 'utf8');
    const issues: DocumentationCheckIssue[] = [];
    // docs/README.md is the index itself, not a classified doc, so it carries no kind/status
    // frontmatter; checkReadmeIndex (called from runDocumentationCheck) covers its own contract instead.
    if (
        relativePath !== DOCS_INDEX_RELATIVE_PATH &&
        relativePath.startsWith('docs/') &&
        relativePath.endsWith('.md')
    ) {
        issues.push(...checkFrontmatter(relativePath, source));
    }
    issues.push(...(await checkLinksAndPaths({ relativePath, repoRoot, repoFiles, source })));
    return issues;
}

export async function runDocumentationCheck(
    repoRoot: string,
    relativePaths: string[],
): Promise<DocumentationCheckIssue[]> {
    const issues: DocumentationCheckIssue[] = [];
    const repoFiles = await listRepoFiles(repoRoot);
    for (const relativePath of relativePaths) {
        // eslint-disable-next-line no-await-in-loop -- sequential keeps output ordered by input file order
        issues.push(...(await checkDocumentationFile(repoRoot, relativePath, repoFiles)));
    }

    const checkedSet = new Set(relativePaths);
    if (checkedSet.has(DOCS_INDEX_RELATIVE_PATH)) {
        const readmeSource = await readFile(join(repoRoot, DOCS_INDEX_RELATIVE_PATH), 'utf8');
        const documentFiles = (
            await collectMarkdownFilesRecursive(join(repoRoot, 'docs'), repoRoot)
        )
            .map((path) => path.slice('docs/'.length))
            .filter((path) => path !== 'README.md');
        issues.push(...checkReadmeIndex(readmeSource, documentFiles));
    }

    return issues.toSorted((a, b) =>
        a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file),
    );
}

export function parseCliArguments(argv: string[]): { files?: string[] } {
    const filesFlagIndex = argv.indexOf('--files');
    if (filesFlagIndex === -1) return {};
    const files = argv.slice(filesFlagIndex + 1);
    if (files.length === 0) throw new Error('--files requires at least one path');
    return { files };
}

/**
 * Resolves a `--files` path against `baseDirectory` (the invoking shell's cwd) and re-expresses it relative to
 * `repoRoot`. `resolve()` (unlike `join()`) treats an already-absolute `path` as the final result, so a caller passing
 * an absolute path (a shell completion, or another script) is not doubled up.
 */
export function relativeToRepoRoot(
    repoRoot: string,
    path: string,
    baseDirectory: string = repoRoot,
): string {
    return relative(repoRoot, resolve(baseDirectory, path)).replaceAll('\\', '/');
}

/**
 * Resolved from this script's own location, not `process.cwd()`: every link and backticked path is repository-relative,
 * so running from a subdirectory must not re-root the whole check there.
 */
const scriptRepoRoot = resolve(import.meta.dirname, '..');

async function main(argv: string[]): Promise<number> {
    const repoRoot = scriptRepoRoot;
    const { files } = parseCliArguments(argv);
    const relativePaths = files
        ? files.map((path) => relativeToRepoRoot(repoRoot, path, process.cwd()))
        : await defaultCheckedFiles(repoRoot);
    const issues = await runDocumentationCheck(repoRoot, relativePaths);
    for (const issue of issues)
        process.stdout.write(`${issue.file}:${issue.line} ${issue.message}\n`);
    if (issues.length > 0) {
        process.stdout.write(
            `documentation-check: ${issues.length} issue(s) across ${relativePaths.length} file(s).\n`,
        );
        return 1;
    }
    process.stdout.write(`documentation-check: ${relativePaths.length} file(s) passed.\n`);
    return 0;
}

if (import.meta.main) {
    try {
        process.exitCode = await main(process.argv.slice(2));
    } catch (error: unknown) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}
