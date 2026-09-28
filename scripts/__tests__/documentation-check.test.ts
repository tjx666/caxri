import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
    checkFrontmatter,
    checkLinksAndPaths,
    checkReadmeIndex,
    collectMarkdownFilesRecursive,
    extractBacktickedRepoPaths,
    extractRelativeLinks,
    frozenLedgerEntryLines,
    isGitIgnoredPath,
    isPathPresentCaseSensitive,
    parseCliArguments as parseCliArguments,
    relativeToRepoRoot,
    runDocumentationCheck,
    shouldSkipPathChecks,
    splitFrontmatter,
} from '../documentation-check';

/**
 * The real repository root, used only to exercise `isGitIgnoredPath` against real `.gitignore` rules.
 */
const realRepoRoot = resolve(import.meta.dirname, '../..');

const temporaryDirectories: string[] = [];

async function createRepoRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'caxri-documentation-check-'));
    temporaryDirectories.push(root);
    return root;
}

async function writeRepoFile(
    repoRoot: string,
    relativePath: string,
    content: string,
): Promise<void> {
    const absolutePath = join(repoRoot, relativePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, 'utf8');
}

afterEach(async () => {
    const directoriesToRemove = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(
        directoriesToRemove.map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

describe('splitFrontmatter', () => {
    it('parses a leading kind/status YAML block and reports the header line count', () => {
        const source = '---\nkind: living\nstatus: current\n---\n\n# Title\n\nBody text\n';
        const { body, frontmatter, headerLines } = splitFrontmatter(source);
        expect(frontmatter).toEqual({ kind: 'living', status: 'current' });
        expect(headerLines).toBe(4);
        expect(body.trimStart().startsWith('# Title')).toBe(true);
    });

    it('returns a null frontmatter for a file with no leading --- block', () => {
        const result = splitFrontmatter('# Title\n\nNo frontmatter here.\n');
        expect(result.frontmatter).toBeNull();
        expect(result.headerLines).toBe(0);
    });

    it('returns a null frontmatter when the closing marker is missing', () => {
        const result = splitFrontmatter('---\nkind: living\n\n# Title\n');
        expect(result.frontmatter).toBeNull();
    });
});

describe('checkFrontmatter', () => {
    it('accepts a valid kind/status pair', () => {
        const source = '---\nkind: adr\nstatus: accepted\n---\n\n# ADR\n';
        expect(checkFrontmatter('docs/adr/0001-example.md', source)).toEqual([]);
    });

    it('flags a file with no frontmatter at all', () => {
        const issues = checkFrontmatter('docs/example.md', '# Title\n');
        expect(issues).toHaveLength(1);
        expect(issues[0].message).toMatch(/missing required/);
    });

    it('flags an invalid kind and an invalid status independently', () => {
        const source = '---\nkind: draft\nstatus: wip\n---\n\n# Title\n';
        const issues = checkFrontmatter('docs/example.md', source);
        expect(issues).toHaveLength(2);
        expect(issues[0].message).toMatch(/invalid "kind"/);
        expect(issues[1].message).toMatch(/invalid "status"/);
    });

    it("rejects a status that is not valid for the given kind's vocabulary is out of scope: only the closed enum is checked", () => {
        // `checkFrontmatter` validates against the flat closed enums, not kind-specific validity;
        // kind/status pairing is a `write-docs` authoring convention, not a mechanical constraint.
        const source = '---\nkind: living\nstatus: superseded\n---\n\n# Title\n';
        expect(checkFrontmatter('docs/example.md', source)).toEqual([]);
    });
});

describe('shouldSkipPathChecks', () => {
    it('skips for historical and superseded status', () => {
        expect(shouldSkipPathChecks('---\nkind: historical\nstatus: historical\n---\n')).toBe(true);
        expect(shouldSkipPathChecks('---\nkind: adr\nstatus: superseded\n---\n')).toBe(true);
    });

    it('does not skip for current status or missing frontmatter', () => {
        expect(shouldSkipPathChecks('---\nkind: living\nstatus: current\n---\n')).toBe(false);
        expect(shouldSkipPathChecks('# No frontmatter\n')).toBe(false);
    });
});

describe('extractRelativeLinks', () => {
    it('extracts a relative link target and strips a trailing anchor', () => {
        const links = extractRelativeLinks('See [the guide](./guide.md#section) for detail.\n');
        expect(links).toEqual([{ line: 1, rawTarget: './guide.md#section', target: './guide.md' }]);
    });

    it('ignores http(s), mailto, and same-document anchor-only links', () => {
        const source = [
            '[external](https://example.com/docs)',
            '[mail](mailto:test@example.com)',
            '[anchor](#section)',
        ].join('\n');
        expect(extractRelativeLinks(source)).toEqual([]);
    });

    it('does not extract a link written inside a fenced code block', () => {
        const source = '```md\n[fake](./not-real.md)\n```\n\n[real](./real.md)\n';
        const links = extractRelativeLinks(source);
        expect(links).toHaveLength(1);
        expect(links[0].target).toBe('./real.md');
        expect(links[0].line).toBe(5);
    });
});

describe('extractBacktickedRepoPaths', () => {
    it('extracts a backticked repository path with an optional :line suffix', () => {
        const source = 'See `docs/cli.md` and `packages/protocol/src/domain/domain.ts:38`.\n';
        const tokens = extractBacktickedRepoPaths(source);
        expect(tokens).toEqual([
            { line: 1, path: 'docs/cli.md' },
            { line: 1, path: 'packages/protocol/src/domain/domain.ts' },
        ]);
    });

    it('skips a glob or placeholder token even when it starts with a repo prefix', () => {
        const source =
            'Matches `docs/**/*.md` and `apps/<workspace>/README.md` and `scripts/*.ts`.\n';
        expect(extractBacktickedRepoPaths(source)).toEqual([]);
    });

    it("skips this repository's own illustrative example filename convention", () => {
        // Matches `scripts/ci-path-policy.ts`'s `CI-E2E-Tests: ["e2e/example.e2e.ts"]` convention.
        expect(extractBacktickedRepoPaths('See `e2e/example.e2e.ts` for the syntax.\n')).toEqual(
            [],
        );
    });

    it('strips a line-range or comma-joined line-range citation suffix', () => {
        const source = 'See `apps/server/src/domains/create-domain-services.ts:535-548,628-633`.\n';
        expect(extractBacktickedRepoPaths(source)).toEqual([
            { line: 1, path: 'apps/server/src/domains/create-domain-services.ts' },
        ]);
    });

    it('ignores backticked paths inside fenced code blocks', () => {
        const source = '```bash\n# see `docs/fake.md`\n```\n\nReal doc: `docs/cli.md`\n';
        const tokens = extractBacktickedRepoPaths(source);
        expect(tokens).toEqual([{ line: 5, path: 'docs/cli.md' }]);
    });

    it('does not extract a token with no owning repository root prefix', () => {
        expect(extractBacktickedRepoPaths('Run `bun run dev` from the repo root.\n')).toEqual([]);
    });
});

describe('isPathPresentCaseSensitive', () => {
    it('resolves an existing nested path and rejects a case-mismatched path', async () => {
        const repoRoot = await createRepoRoot();
        await writeRepoFile(repoRoot, 'docs/mobile/update.md', '# Update\n');

        expect(await isPathPresentCaseSensitive(repoRoot, 'docs/mobile/update.md')).toBe(true);
        // This is the exact bug class the case-insensitive-but-preserving macOS filesystem hides:
        // a stale-cased reference to a since-renamed file must fail here even though `existsSync`
        // would resolve it on a case-insensitive volume.
        expect(await isPathPresentCaseSensitive(repoRoot, 'docs/mobile/UPDATE.md')).toBe(false);
    });

    it('rejects a path under a directory that does not exist', async () => {
        const repoRoot = await createRepoRoot();
        expect(await isPathPresentCaseSensitive(repoRoot, 'docs/missing/file.md')).toBe(false);
    });
});

describe('checkLinksAndPaths', () => {
    it('reports a broken relative link with its 1-indexed line number', async () => {
        const repoRoot = await createRepoRoot();
        const source = '---\nkind: living\nstatus: current\n---\n\n[gone](./missing.md)\n';
        const issues = await checkLinksAndPaths({
            relativePath: 'docs/example.md',
            repoRoot,
            source,
        });
        expect(issues).toEqual([
            {
                file: 'docs/example.md',
                line: 6,
                message: 'broken relative link target: ./missing.md',
            },
        ]);
    });

    it('reports a broken backticked repository path', async () => {
        const repoRoot = await createRepoRoot();
        const source =
            '---\nkind: living\nstatus: current\n---\n\nSee `apps/desktop/src/gone.ts` for detail.\n';
        const issues = await checkLinksAndPaths({
            relativePath: 'docs/example.md',
            repoRoot,
            source,
        });
        expect(issues).toEqual([
            {
                file: 'docs/example.md',
                line: 6,
                message: 'backticked repository path does not exist: apps/desktop/src/gone.ts',
            },
        ]);
    });

    it('skips the backticked-path check but still checks links for historical/superseded status', async () => {
        const repoRoot = await createRepoRoot();
        await writeRepoFile(repoRoot, 'docs/current.md', '# Current\n');
        const source = [
            '---',
            'kind: historical',
            'status: historical',
            '---',
            '',
            'Old path `src/renderer/app.tsx` no longer exists, see [current](./current.md).',
            'Broken link: [gone](./missing.md).',
            '',
        ].join('\n');
        const issues = await checkLinksAndPaths({ relativePath: 'docs/old.md', repoRoot, source });
        expect(issues).toEqual([
            { file: 'docs/old.md', line: 7, message: 'broken relative link target: ./missing.md' },
        ]);
    });

    it("resolves a link relative to the linking file's own directory", async () => {
        const repoRoot = await createRepoRoot();
        await writeRepoFile(repoRoot, 'docs/mobile/update.md', '# Update\n');
        const source = '---\nkind: living\nstatus: current\n---\n\n[update](update.md)\n';
        const issues = await checkLinksAndPaths({
            relativePath: 'docs/mobile/transport.md',
            repoRoot,
            source,
        });
        expect(issues).toEqual([]);
    });

    it('accepts a backticked path git would never track instead of reporting it missing', async () => {
        // Real repo root: `out/` is gitignored at the top level (see `.gitignore`), so a doc that
        // cites where a build artifact lands must not be flagged even though a clean checkout
        // never contains it.
        const source =
            '---\nkind: living\nstatus: current\n---\n\nSee `out/renderer` after a build.\n';
        const issues = await checkLinksAndPaths({
            relativePath: 'docs/example.md',
            repoRoot: realRepoRoot,
            source,
        });
        expect(issues).toEqual([]);
    });
});

describe('isGitIgnoredPath', () => {
    it('is true for a top-level gitignored build output directory', async () => {
        expect(await isGitIgnoredPath(realRepoRoot, 'out/renderer')).toBe(true);
    });

    it('is true for a path gitignored only via a nested .gitignore', async () => {
        // `apps/mobile/.gitignore` ignores `android/`, not the root `.gitignore`.
        expect(
            await isGitIgnoredPath(
                realRepoRoot,
                'apps/mobile/android/app/build/outputs/apk/release/app-release.apk',
            ),
        ).toBe(true);
    });

    it('is false for a tracked source path', async () => {
        expect(await isGitIgnoredPath(realRepoRoot, 'docs/cli.md')).toBe(false);
    });

    it('fails closed (false) when repoRoot is not a Git repository', async () => {
        const bareRoot = await createRepoRoot();
        expect(await isGitIgnoredPath(bareRoot, 'out/renderer')).toBe(false);
    });
});

describe('frozenLedgerEntryLines', () => {
    it('freezes lines inside a RESOLVED or STALE ledger entry but not an OPEN one', () => {
        const source = [
            '### AD-open-example — [OPEN · Architecture debt · M]',
            '',
            '- **Evidence:** `apps/live.ts:1`',
            '',
            '### AD-resolved-example — [RESOLVED · Confirmed defect · M]',
            '',
            '- **Evidence:** `apps/gone.ts:2`',
            '',
            '### AD-stale-example — [STALE · Coverage gap · S]',
            '',
            '- **Evidence:** `apps/also-gone.ts:3`',
            '',
            '## Next section',
            '',
            '- **Evidence:** `apps/after-section.ts:4`',
            '',
        ].join('\n');
        const frozen = frozenLedgerEntryLines(source);
        expect(frozen.has(3)).toBe(false);
        expect(frozen.has(7)).toBe(true);
        expect(frozen.has(11)).toBe(true);
        expect(frozen.has(15)).toBe(false);
    });

    it('checkLinksAndPaths does not flag a broken path inside a RESOLVED ledger entry', async () => {
        const repoRoot = await createRepoRoot();
        const source = [
            '---',
            'kind: living',
            'status: current',
            '---',
            '',
            '### AD-example — [RESOLVED · Confirmed defect · M]',
            '',
            '- **Evidence:** `apps/renamed-since.ts:5` implemented the fix.',
            '',
        ].join('\n');
        const issues = await checkLinksAndPaths({
            relativePath: 'docs/architecture-debt.md',
            repoRoot,
            source,
        });
        expect(issues).toEqual([]);
    });
});

describe('checkReadmeIndex', () => {
    it('flags a doc file with no matching index entry', () => {
        const readme = '# Index\n\n[cli.md](cli.md)\n';
        const issues = checkReadmeIndex(readme, ['cli.md', 'extensions.md']);
        expect(issues).toEqual([
            {
                file: 'docs/README.md',
                line: 1,
                message: 'docs/README.md is missing an index entry for docs/extensions.md',
            },
        ]);
    });

    it('passes when every doc file has a matching index entry', () => {
        const readme = '# Index\n\n[cli.md](cli.md)\n[adr/0001-x.md](adr/0001-x.md)\n';
        expect(checkReadmeIndex(readme, ['cli.md', 'adr/0001-x.md'])).toEqual([]);
    });
});

describe('collectMarkdownFilesRecursive', () => {
    it('finds nested Markdown files and returns repo-relative POSIX paths', async () => {
        const repoRoot = await createRepoRoot();
        await writeRepoFile(repoRoot, 'docs/cli.md', '# CLI\n');
        await writeRepoFile(repoRoot, 'docs/adr/0001-example.md', '# ADR\n');
        await writeRepoFile(repoRoot, 'docs/notes.txt', 'not markdown\n');
        const files = (
            await collectMarkdownFilesRecursive(join(repoRoot, 'docs'), repoRoot)
        ).toSorted((a, b) => a.localeCompare(b));
        expect(files).toEqual(['docs/adr/0001-example.md', 'docs/cli.md']);
    });
});

describe('parseCliArguments', () => {
    it('returns no files when --files is absent', () => {
        expect(parseCliArguments([])).toEqual({});
    });

    it('captures every argument after --files', () => {
        expect(parseCliArguments(['--files', 'docs/cli.md', 'CONTEXT.md'])).toEqual({
            files: ['docs/cli.md', 'CONTEXT.md'],
        });
    });

    it('throws when --files is given with no paths', () => {
        expect(() => parseCliArguments(['--files'])).toThrow(/requires at least one path/);
    });
});

describe('relativeToRepoRoot', () => {
    it('resolves a relative --files path against repoRoot', () => {
        expect(relativeToRepoRoot('/repo', 'docs/cli.md')).toBe('docs/cli.md');
    });

    it('does not double repoRoot onto an already-absolute --files path', () => {
        // Regression for a bug where `join(repoRoot, path)` concatenated an absolute `path` onto `repoRoot` instead
        // of using it as-is, doubling the prefix (e.g. `/repo/repo/docs/cli.md`).
        expect(relativeToRepoRoot('/repo', '/repo/docs/cli.md')).toBe('docs/cli.md');
    });
});

describe('runDocumentationCheck', () => {
    it('passes a fully consistent fixture repo with zero issues', async () => {
        const repoRoot = await createRepoRoot();
        await writeRepoFile(
            repoRoot,
            'docs/cli.md',
            '---\nkind: living\nstatus: current\n---\n\n# CLI\n\nSee [ADR 0001](adr/0001-example.md).\n',
        );
        await writeRepoFile(
            repoRoot,
            'docs/adr/0001-example.md',
            '---\nkind: adr\nstatus: accepted\n---\n\n# ADR 0001\n',
        );
        await writeRepoFile(
            repoRoot,
            'docs/README.md',
            '# Index\n\n[cli.md](cli.md)\n[adr/0001-example.md](adr/0001-example.md)\n',
        );
        await writeRepoFile(repoRoot, 'CONTEXT.md', '# Context\n\nSee [docs](docs/README.md).\n');
        await writeRepoFile(repoRoot, 'AGENTS.md', '# Agents\n\nSee `docs/cli.md`.\n');

        const issues = await runDocumentationCheck(repoRoot, [
            'docs/cli.md',
            'docs/adr/0001-example.md',
            'docs/README.md',
            'CONTEXT.md',
            'AGENTS.md',
        ]);
        expect(issues).toEqual([]);
    });

    it('collects frontmatter, link, path, and README-index issues together, sorted by file then line', async () => {
        const repoRoot = await createRepoRoot();
        await writeRepoFile(repoRoot, 'docs/cli.md', '# CLI\n\n[gone](./missing.md)\n');
        await writeRepoFile(repoRoot, 'docs/README.md', '# Index\n');

        const issues = await runDocumentationCheck(repoRoot, ['docs/cli.md', 'docs/README.md']);
        expect(issues).toEqual([
            {
                file: 'docs/cli.md',
                line: 1,
                message: 'missing required "kind"/"status" YAML frontmatter',
            },
            { file: 'docs/cli.md', line: 3, message: 'broken relative link target: ./missing.md' },
            {
                file: 'docs/README.md',
                line: 1,
                message: 'docs/README.md is missing an index entry for docs/cli.md',
            },
        ]);
    });
});
