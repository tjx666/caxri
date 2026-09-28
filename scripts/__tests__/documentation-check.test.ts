import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
    checkFrontmatter,
    checkLinksAndPaths,
    checkReadmeIndex,
    collectMarkdownFilesRecursive,
    isGitIgnoredPath,
    isPathPresentCaseSensitive,
    isSourceFilenameResolvable,
    listRepoFiles,
    parseCliArguments as parseCliArguments,
    relativeToRepoRoot,
    runDocumentationCheck,
    shouldSkipPathChecks,
    splitFrontmatter,
} from '../documentation-check';
import { execFileAsync } from '../exec';

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
    it('does not flag a broken path inside a RESOLVED ledger entry', async () => {
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

    it('reports a broken cross-document or same-document anchor but accepts a valid one', async () => {
        const repoRoot = await createRepoRoot();
        await writeRepoFile(repoRoot, 'docs/guide.md', '# Guide\n\n## Remote diagnosis\n');
        const source = [
            '# Page',
            '',
            '## Local section',
            '',
            '[ok](./guide.md#remote-diagnosis) [gone](./guide.md#remote-diagnostics)',
            '[here](#local-section) [nowhere](#missing-section)',
        ].join('\n');
        const issues = await checkLinksAndPaths({ relativePath: 'docs/page.md', repoRoot, source });
        expect(issues).toEqual([
            {
                file: 'docs/page.md',
                line: 5,
                message: 'broken link anchor: ./guide.md#remote-diagnostics',
            },
            { file: 'docs/page.md', line: 6, message: 'broken link anchor: #missing-section' },
        ]);
    });

    it('leaves a GitHub line anchor on a non-Markdown target alone', async () => {
        const repoRoot = await createRepoRoot();
        await writeRepoFile(repoRoot, 'scripts/tool.ts', 'export {};\n');
        const issues = await checkLinksAndPaths({
            relativePath: 'docs/page.md',
            repoRoot,
            source: '[line](../scripts/tool.ts#L1)\n',
        });
        expect(issues).toEqual([]);
    });

    it('reports a bare source filename that no repository file ends with', async () => {
        const repoRoot = await createRepoRoot();
        const issues = await checkLinksAndPaths({
            relativePath: 'docs/page.md',
            repoFiles: ['apps/server/src/domains/project-status/branch.ts'],
            repoRoot,
            source: 'Cached in `branch.ts`; formerly `project-status-branch.ts`.\n',
        });
        expect(issues).toEqual([
            {
                file: 'docs/page.md',
                line: 1,
                message:
                    'backticked source filename matches no repository file: project-status-branch.ts',
            },
        ]);
    });

    it('does not resolve bare source filenames in a historical doc', async () => {
        const repoRoot = await createRepoRoot();
        const issues = await checkLinksAndPaths({
            relativePath: 'docs/page.md',
            repoFiles: [],
            repoRoot,
            source: '---\nkind: historical\nstatus: historical\n---\n\nWas `gone.ts`.\n',
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

describe('isSourceFilenameResolvable', () => {
    it('matches a whole path or a suffix that starts at a path segment boundary', () => {
        const files = ['apps/server/src/domains/project-status/branch.ts'];
        expect(isSourceFilenameResolvable(files, 'branch.ts')).toBe(true);
        expect(isSourceFilenameResolvable(files, 'project-status/branch.ts')).toBe(true);
        expect(isSourceFilenameResolvable(files, 'status/branch.ts')).toBe(false);
        expect(isSourceFilenameResolvable(files, 'anch.ts')).toBe(false);
    });
});

describe('listRepoFiles', () => {
    it('lists tracked files in a Git repository', async () => {
        expect(await listRepoFiles(realRepoRoot)).toContain('scripts/documentation-check.ts');
    });

    it('returns null outside a Git repository', async () => {
        expect(await listRepoFiles(await createRepoRoot())).toBeNull();
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

    it("resolves a relative --files path against the invoking shell's directory", () => {
        expect(relativeToRepoRoot('/repo', '../CONTEXT.md', '/repo/docs')).toBe('CONTEXT.md');
    });
});

describe('documentation-check CLI', () => {
    it('keeps the repository root when invoked from a subdirectory', async () => {
        // Regression: the root used to be `process.cwd()`, so running from `docs/` re-rooted every repository path
        // under `docs/` and reported each one missing.
        const { stdout } = await execFileAsync(
            'bun',
            [resolve(realRepoRoot, 'scripts/documentation-check.ts'), '--files', 'cli.md'],
            { cwd: resolve(realRepoRoot, 'docs') },
        );
        expect(stdout).toContain('documentation-check: 1 file(s) passed.');
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
