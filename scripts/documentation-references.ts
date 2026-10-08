/**
 * Pure Markdown reference extraction for `scripts/documentation-check.ts`: fenced-block stripping, relative links and
 * their anchors, GitHub heading slugs, and backticked repository paths or source filenames. Nothing here touches the
 * filesystem, so the checker owns every existence decision.
 */

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

const LEDGER_ENTRY_HEADING = /^###\s+(?:\S.*)?\[(?:RESOLVED|STALE)\b/;
const ANY_HEADING = /^#{1,6}\s+/;

/**
 * Returns the 1-indexed line numbers inside a `### <id>: [RESOLVED ...]` or `[STALE ...]` entry, the
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
function stripFencedCodeBlocks(source: string): string {
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
    /**
     * The `#anchor` part without its `#`, or `undefined` when the link names no anchor.
     */
    fragment?: string;
    line: number;
    rawTarget: string;
    /**
     * The path part; an empty string means a same-document `#anchor` link.
     */
    target: string;
}

/**
 * Extracts `[text](target)` / `![alt](target)` links whose target is not an external URL or a mailto link, including
 * same-document `#anchor` links.
 */
export function extractRelativeLinks(source: string): RelativeLinkTarget[] {
    const withoutFences = stripFencedCodeBlocks(source);
    const links: RelativeLinkTarget[] = [];
    withoutFences.split('\n').forEach((line, index) => {
        for (const match of line.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
            const rawTarget = match[1].trim();
            const target = rawTarget.split(/\s+/, 1)[0];
            if (!target || target === '#') continue;
            if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // any URI scheme (http(s), mailto, ...)
            const fragmentIndex = target.indexOf('#');
            links.push(
                fragmentIndex === -1
                    ? { line: index + 1, rawTarget, target }
                    : {
                          fragment: target.slice(fragmentIndex + 1),
                          line: index + 1,
                          rawTarget,
                          target: target.slice(0, fragmentIndex),
                      },
            );
        }
    });
    return links;
}

/**
 * Approximates GitHub's heading anchor algorithm (`github-slugger`): link and HTML markup reduce to their visible text,
 * then the text is lowercased, everything except letters, marks, numbers, connector punctuation (`_`), spaces, and
 * hyphens is dropped, and each space becomes a hyphen.
 */
export function githubHeadingSlug(heading: string): string {
    return heading
        .replaceAll(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replaceAll(/<[^>]+>/g, '')
        .toLowerCase()
        .replaceAll(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
        .replaceAll(' ', '-');
}

/**
 * Collects every anchor GitHub renders for a Markdown file: one per ATX heading, with GitHub's `-1`, `-2` suffix for a
 * repeated slug, plus explicit `<a id>` / `<a name>` targets.
 */
export function collectMarkdownAnchors(source: string): Set<string> {
    const anchors = new Set<string>();
    const slugOccurrences = new Map<string, number>();
    for (const line of stripFencedCodeBlocks(source).split('\n')) {
        const heading = /^ {0,3}#{1,6}\s(.*)$/.exec(line);
        if (heading) {
            // An ATX heading may close with a run of `#`s that GitHub does not render.
            const slug = githubHeadingSlug(heading[1].trim().replace(/\s#+$/, ''));
            const occurrence = slugOccurrences.get(slug) ?? 0;
            slugOccurrences.set(slug, occurrence + 1);
            anchors.add(occurrence === 0 ? slug : `${slug}-${occurrence}`);
        }
        for (const match of line.matchAll(/<a\s[^>]*\b(?:id|name)=["']([^"']+)["']/gi))
            anchors.add(match[1]);
    }
    return anchors;
}

export function decodeFragment(fragment: string): string {
    try {
        return decodeURIComponent(fragment);
    } catch {
        return fragment;
    }
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

function trimCandidatePunctuation(candidate: string): string {
    return candidate.replace(/^[(["'{]+/, '').replace(/[)\]"'},;.]+$/, '');
}

/**
 * Strips an optional trailing `:123`, `:123-456`, or comma-joined list of either (e.g. `:535-548,628-633`), the
 * citation format `docs/architecture-debt.md` uses.
 */
function stripLineCitation(token: string): string {
    return token.replace(/:\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/, '');
}

/**
 * Returns the repo-relative path a single space-delimited backticked candidate names, or `null` when it is not one (a
 * glob, a `<placeholder>`, or a token with no owning repository root prefix).
 */
function repoPathFromCandidate(candidate: string): string | null {
    const token = trimCandidatePunctuation(candidate);
    if (isPlaceholderOrGlob(token)) return null;
    if (REPO_PATH_PREFIXES.every((prefix) => !token.startsWith(prefix))) return null;
    return stripLineCitation(token);
}

const SOURCE_FILENAME = /^[\w@][\w.@/-]*\.(?:ts|tsx|mts|cts)$/;

/**
 * Returns the path suffix a backticked TypeScript source filename without an owning repository root names (`branch.ts`,
 * `project-status/branch.ts`, or an elided `.../project-status/branch.ts`), or `null` when the candidate is not one.
 * These are the references a module rename or directory move strands silently, because no root prefix routes them
 * through `repoPathFromCandidate`.
 */
function sourceFilenameFromCandidate(candidate: string): string | null {
    const token = stripLineCitation(trimCandidatePunctuation(candidate)).replace(
        /^(?:\.{1,3}\/)+/,
        '',
    );
    if (!SOURCE_FILENAME.test(token) || isPlaceholderOrGlob(token)) return null;
    if (REPO_PATH_PREFIXES.some((prefix) => token.startsWith(prefix))) return null;
    return token;
}

function extractBacktickedCandidates<T>(
    source: string,
    fromCandidate: (candidate: string) => T | null,
): Array<{ line: number; value: T }> {
    const withoutFences = stripFencedCodeBlocks(source);
    const results: Array<{ line: number; value: T }> = [];
    withoutFences.split('\n').forEach((line, index) => {
        for (const match of line.matchAll(/`([^`]+)`/g)) {
            const candidates = match[1].trim().split(/\s+/);
            for (const candidate of candidates) {
                const value = fromCandidate(candidate);
                if (value !== null) results.push({ line: index + 1, value });
            }
        }
    });
    return results;
}

/**
 * Extracts backticked tokens that begin with an owning repository root and are not obviously a glob or a
 * `<placeholder>`.
 */
export function extractBacktickedRepoPaths(source: string): RepoPathToken[] {
    return extractBacktickedCandidates(source, repoPathFromCandidate).map(({ line, value }) => ({
        line,
        path: value,
    }));
}

export interface SourceFilenameToken {
    line: number;
    /**
     * A filename or trailing path fragment that must match the end of some repository file path.
     */
    suffix: string;
}

/**
 * Extracts backticked TypeScript source filenames that carry no owning repository root, such as `branch.ts`.
 */
export function extractBacktickedSourceFilenames(source: string): SourceFilenameToken[] {
    return extractBacktickedCandidates(source, sourceFilenameFromCandidate).map(
        ({ line, value }) => ({ line, suffix: value }),
    );
}
