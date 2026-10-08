import { describe, expect, it } from 'vitest';

import {
    collectMarkdownAnchors,
    extractBacktickedRepoPaths,
    extractBacktickedSourceFilenames,
    extractRelativeLinks,
    frozenLedgerEntryLines,
    githubHeadingSlug,
} from '../documentation-references';

describe('extractRelativeLinks', () => {
    it('splits a relative link target into its path and anchor', () => {
        const links = extractRelativeLinks('See [the guide](./guide.md#section) for detail.\n');
        expect(links).toEqual([
            { fragment: 'section', line: 1, rawTarget: './guide.md#section', target: './guide.md' },
        ]);
    });

    it('keeps a same-document anchor link with an empty path and ignores http(s) and mailto', () => {
        const source = [
            '[external](https://example.com/docs#section)',
            '[mail](mailto:test@example.com)',
            '[anchor](#section)',
        ].join('\n');
        expect(extractRelativeLinks(source)).toEqual([
            { fragment: 'section', line: 3, rawTarget: '#section', target: '' },
        ]);
    });

    it('does not extract a link written inside a fenced code block', () => {
        const source = '```md\n[fake](./not-real.md)\n```\n\n[real](./real.md)\n';
        const links = extractRelativeLinks(source);
        expect(links).toHaveLength(1);
        expect(links[0].target).toBe('./real.md');
        expect(links[0].line).toBe(5);
    });
});

describe('githubHeadingSlug', () => {
    it('matches the anchors GitHub renders for headings this repository uses', () => {
        expect(githubHeadingSlug('Remote diagnosis')).toBe('remote-diagnosis');
        expect(githubHeadingSlug('Import `dianjiang` presets')).toBe('import-dianjiang-presets');
        expect(githubHeadingSlug('External callers and directory authorization')).toBe(
            'external-callers-and-directory-authorization',
        );
        expect(githubHeadingSlug('What `files.*` owns (v2)')).toBe('what-files-owns-v2');
        expect(githubHeadingSlug('See [the guide](./guide.md) first')).toBe('see-the-guide-first');
        expect(githubHeadingSlug('snake_case & Case')).toBe('snake_case--case');
        expect(githubHeadingSlug('中文 标题')).toBe('中文-标题');
    });
});

describe('collectMarkdownAnchors', () => {
    it('suffixes repeated headings, strips a closing hash run, and adds explicit HTML anchors', () => {
        const source = [
            '# Title',
            '## Setup',
            '## Setup',
            '### Closed heading ###',
            '<a id="custom-target"></a>',
            '```md',
            '## Not a heading',
            '```',
        ].join('\n');
        expect([...collectMarkdownAnchors(source)]).toEqual([
            'title',
            'setup',
            'setup-1',
            'closed-heading',
            'custom-target',
        ]);
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

describe('extractBacktickedSourceFilenames', () => {
    it('extracts bare, partial, and elided TypeScript source filenames', () => {
        const source =
            'See `branch.ts`, `project-status/branch.ts:12`, `.../agent-activity-view.tsx`, and `./index.ts`.\n';
        expect(extractBacktickedSourceFilenames(source)).toEqual([
            { line: 1, suffix: 'branch.ts' },
            { line: 1, suffix: 'project-status/branch.ts' },
            { line: 1, suffix: 'agent-activity-view.tsx' },
            { line: 1, suffix: 'index.ts' },
        ]);
    });

    it('skips rooted paths, globs, suffix patterns, the example convention, and non-TypeScript names', () => {
        const source =
            '`apps/server/src/index.ts` `*.test.ts` `-actions.ts` `example.ts` `package.json` `.d.ts`\n';
        expect(extractBacktickedSourceFilenames(source)).toEqual([]);
    });
});

describe('frozenLedgerEntryLines', () => {
    it('freezes lines inside a RESOLVED or STALE ledger entry but not an OPEN one', () => {
        const source = [
            '### AD-open-example: [OPEN · Architecture debt · M]',
            '',
            '- **Evidence:** `apps/live.ts:1`',
            '',
            '### AD-resolved-example: [RESOLVED · Confirmed defect · M]',
            '',
            '- **Evidence:** `apps/gone.ts:2`',
            '',
            '### AD-stale-example: [STALE · Coverage gap · S]',
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
});
