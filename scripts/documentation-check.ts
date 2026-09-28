/**
 * Validates the documentation contract defined by `.agents/skills/write-docs/SKILL.md`: closed-enum frontmatter on
 * every `docs/**\/*.md` file, `docs/README.md` index completeness, relative Markdown link/anchor targets, and
 * backticked repository paths. `CONTEXT.md` and `AGENTS.md` get link/path checks only — they carry no frontmatter and
 * are not part of the `docs/` index.
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

const REPO_PATH_PREFIXES = [
    'apps/',
    'packages/',
    'extensions/',
    'e2e/',
    'scripts/',
    'tools/',
    '.agents/',
    'docs/',
    'build/',
    'skills/',
];

const DOCS_INDEX_RELATIVE_PATH = 'docs/README.md';
const ALWAYS_CHECKED_ROOT_FILES = ['CONTEXT.md', 'AGENTS.md'];

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

const LEDGER_ENTRY_HEADING = /^###\s+(?:\S.*)?\[(?:RESOLVED|STALE)\b/;
const ANY_HEADING = /^#{1,6}\s+/;

/**
 * Returns the 1-indexed line numbers inside a `### <id> — [RESOLVED ...]` or `[STALE ...]` entry — the
 * `audit-architecture-debt` skill's ledger format used by `docs/architecture-debt.md`. That skill's own reference doc
 * (`.agents/skills/audit-architecture-debt/references/debt-ledger.md`) only refreshes evidence for revalidated `OPEN`
 * entries; a `RESOLVED`/`STALE` entry's `Evidence:` citation is a point-in-time record of the commit that resolved or
 * last verified it, and the ledger's own maintenance policy is to "refresh semantic evidence, not paths" for those, so
 * a later rename or deletion of the cited file is expected, not drift for this checker to flag.
 */
export function frozenLedgerEntryLines(source: string): Set<number> {
    const frozen = new Set<number>();
    let isInFrozenEntry = false;
    source.split('\n').forEach((line, index) => {
        if (LEDGER_ENTRY_HEADING.test(line)) isInFrozenEntry = true;
        else if (ANY_HEADING.test(line)) isInFrozenEntry = false;
        if (isInFrozenEntry) frozen.add(index + 1);
    });
    return frozen;
}

/**
 * Blanks fenced ````` code-block lines so example commands and ASCII diagrams never produce false-positive path
 * findings, while keeping every line number stable.
 */
export function stripFencedCodeBlocks(source: string): string {
    const lines = source.split('\n');
    let isInFence = false;
    return lines
        .map((line) => {
            if (/^\s{0,3}```/.test(line)) {
                isInFence = !isInFence;
                return '';
            }
            return isInFence ? '' : line;
        })
        .join('\n');
}

export interface RelativeLinkTarget {
    line: number;
    rawTarget: string;
    target: string;
}

/**
 * Extracts `[text](target)` / `![alt](target)` links whose target is not an external URL, a mailto link, or a
 * same-document `#anchor`.
 */
export function extractRelativeLinks(source: string): RelativeLinkTarget[] {
    const withoutFences = stripFencedCodeBlocks(source);
    const links: RelativeLinkTarget[] = [];
    withoutFences.split('\n').forEach((line, index) => {
        for (const match of line.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
            const rawTarget = match[1].trim();
            const target = rawTarget.split(/\s+/, 1)[0];
            if (!target || target.startsWith('#')) continue;
            if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // any URI scheme (http(s), mailto, ...)
            links.push({ line: index + 1, rawTarget, target: target.split('#', 1)[0] });
        }
    });
    return links.filter((link) => link.target.length > 0);
}

function isPlaceholderOrGlob(token: string): boolean {
    if (/[*?<>{}[\]$]|\.\.\.\B/.test(token)) return true;
    // `example` is this repository's own illustrative-filename convention (see
    // `scripts/ci-path-policy.ts`'s `CI-E2E-Tests: ["e2e/example.e2e.ts"]` JSDoc and its test
    // fixtures), not a stale reference to a real spec.
    return /(?:^|\/)example\./i.test(token);
}

export interface RepoPathToken {
    line: number;
    path: string;
}

/**
 * Returns the repo-relative path a single space-delimited backticked candidate names, or `null` when it is not one (a
 * glob, a `<placeholder>`, or a token with no owning repository root prefix).
 */
function repoPathFromCandidate(candidate: string): string | null {
    const token = candidate.replace(/^[(["'{]+/, '').replace(/[)\]"'},;.]+$/, '');
    if (isPlaceholderOrGlob(token)) return null;
    if (REPO_PATH_PREFIXES.every((prefix) => !token.startsWith(prefix))) return null;
    // Strips an optional trailing `:123`, `:123-456`, or comma-joined list of either (e.g.
    // `:535-548,628-633`), the citation format `docs/architecture-debt.md` uses.
    return token.replace(/:\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/, '');
}

/**
 * Extracts backticked tokens that begin with an owning repository root and are not obviously a glob or a
 * `<placeholder>`.
 */
export function extractBacktickedRepoPaths(source: string): RepoPathToken[] {
    const withoutFences = stripFencedCodeBlocks(source);
    const results: RepoPathToken[] = [];
    withoutFences.split('\n').forEach((line, index) => {
        for (const match of line.matchAll(/`([^`]+)`/g)) {
            const content = match[1].trim();
            const candidates = /\s/.test(content) ? content.split(/\s+/) : [content];
            for (const candidate of candidates) {
                const path = repoPathFromCandidate(candidate);
                if (path) results.push({ line: index + 1, path });
            }
        }
    });
    return results;
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
 * check-ignore` already resolves correctly — re-deriving that logic by hand here is the kind of second copy that
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
    source: string;
}

export async function checkLinksAndPaths({
    relativePath,
    repoRoot,
    source,
}: CheckFileOptions): Promise<DocumentationCheckIssue[]> {
    const issues: DocumentationCheckIssue[] = [];
    const relativeFileDirectory = dirname(relativePath);
    const frozenLines = frozenLedgerEntryLines(source);

    for (const link of extractRelativeLinks(source)) {
        if (frozenLines.has(link.line)) continue;
        const targetRelativeToRepoRoot = link.target.startsWith('/')
            ? link.target.slice(1)
            : relative(repoRoot, join(repoRoot, relativeFileDirectory, link.target));
        // eslint-disable-next-line no-await-in-loop -- a doc has few links; sequential keeps issues in document order
        if (!(await isPathAcceptable(repoRoot, targetRelativeToRepoRoot))) {
            issues.push({
                file: relativePath,
                line: link.line,
                message: `broken relative link target: ${link.rawTarget}`,
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
    issues.push(...(await checkLinksAndPaths({ relativePath, repoRoot, source })));
    return issues;
}

export async function runDocumentationCheck(
    repoRoot: string,
    relativePaths: string[],
): Promise<DocumentationCheckIssue[]> {
    const issues: DocumentationCheckIssue[] = [];
    for (const relativePath of relativePaths) {
        // eslint-disable-next-line no-await-in-loop -- sequential keeps output ordered by input file order
        issues.push(...(await checkDocumentationFile(repoRoot, relativePath)));
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
 * `resolve()` (unlike `join()`) treats an already-absolute `path` as the final result instead of concatenating it onto
 * `repoRoot`, so a caller passing `--files` an absolute path is not doubled up (e.g. `--files` from a shell completion,
 * or another script that always passes absolute paths).
 */
export function relativeToRepoRoot(repoRoot: string, path: string): string {
    return relative(repoRoot, resolve(repoRoot, path)).replaceAll('\\', '/');
}

async function main(argv: string[]): Promise<number> {
    const repoRoot = process.cwd();
    const { files } = parseCliArguments(argv);
    const inputFiles = files ?? (await defaultCheckedFiles(repoRoot));
    const relativePaths = inputFiles.map((path) => relativeToRepoRoot(repoRoot, path));
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
