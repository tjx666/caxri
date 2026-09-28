import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { RatchetCandidate } from '../source-size-ratchet';
import {
    collectRatchetCandidates,
    countLines,
    evaluateRatchet,
    isRatchetCandidatePath,
    parseNameStatusRecords,
    RATCHET_LINE_THRESHOLD,
    resolveRatchetBase,
} from '../source-size-ratchet';

describe('resolveRatchetBase', () => {
    const mergeBase = () => Promise.resolve('merge-base-sha');

    it('prefers an explicit --base over the CI base and the origin/main merge-base', async () => {
        expect(
            await resolveRatchetBase(
                ['--base', 'v1'],
                { CAXRI_REACT_DOCTOR_BASE: 'ci-sha' },
                mergeBase,
            ),
        ).toBe('v1');
    });

    it('uses the CI-provided base in a checkout that has no origin/main ref', async () => {
        const unreachable = () =>
            Promise.reject(new Error('fatal: Not a valid object name origin/main'));
        expect(
            await resolveRatchetBase([], { CAXRI_REACT_DOCTOR_BASE: ' ci-sha ' }, unreachable),
        ).toBe('ci-sha');
    });

    it('skips on the all-zero before SHA of an initial branch push', async () => {
        expect(
            await resolveRatchetBase([], { CAXRI_REACT_DOCTOR_BASE: '0'.repeat(40) }, mergeBase),
        ).toBeNull();
    });

    it('falls back to the origin/main merge-base locally', async () => {
        expect(await resolveRatchetBase([], { CAXRI_REACT_DOCTOR_BASE: ' ' }, mergeBase)).toBe(
            'merge-base-sha',
        );
    });
});

describe('countLines', () => {
    it('treats a trailing newline as the end of the last line, not an extra line', () => {
        expect(countLines('a\nb\n')).toBe(2);
        expect(countLines('a\nb')).toBe(2);
    });

    it('treats an empty file as zero lines', () => {
        expect(countLines('')).toBe(0);
    });

    it('counts a single line with or without a trailing newline', () => {
        expect(countLines('a')).toBe(1);
        expect(countLines('a\n')).toBe(1);
    });
});

describe('isRatchetCandidatePath', () => {
    it('accepts a source extension under a ratcheted root', () => {
        expect(isRatchetCandidatePath('apps/desktop/src/main/index.ts')).toBe(true);
        expect(isRatchetCandidatePath('packages/system/src/filesystem/exec.ts')).toBe(true);
        expect(isRatchetCandidatePath('scripts/source-size-ratchet.ts')).toBe(true);
        expect(isRatchetCandidatePath('e2e/smoke.e2e.ts')).toBe(true);
        expect(isRatchetCandidatePath('.agents/skills/quality-check/scripts/check.ts')).toBe(true);
    });

    it('rejects a path outside the ratcheted roots', () => {
        expect(isRatchetCandidatePath('docs/architecture/overview.md')).toBe(false);
        expect(isRatchetCandidatePath('tools/oxlint/anti-slop/index.ts')).toBe(false);
    });

    it('rejects an extension the ratchet does not track', () => {
        expect(isRatchetCandidatePath('apps/desktop/src/main/index.mjs')).toBe(false);
        expect(isRatchetCandidatePath('docs/architecture/overview.md')).toBe(false);
        expect(isRatchetCandidatePath('apps/desktop/package.json')).toBe(false);
    });

    it('rejects generated and vendored paths even when the extension and root match', () => {
        expect(isRatchetCandidatePath('apps/mobile/android/app/build/Generated.js')).toBe(false);
        expect(isRatchetCandidatePath('scripts/fixtures/eslint/broken.ts')).toBe(false);
        expect(isRatchetCandidatePath('scripts/fixtures/markdown/broken.ts')).toBe(false);
        expect(isRatchetCandidatePath('.agents/skills/design-prototype/assets/vendor.js')).toBe(
            false,
        );
    });

    it('rejects a generated data manifest that ESLint still lints but this ratchet cannot ask to be split', () => {
        expect(
            isRatchetCandidatePath('apps/mobile/src/features/panels/file-icons.generated.ts'),
        ).toBe(false);
    });
});

describe('parseNameStatusRecords', () => {
    it('parses a simple modified record', () => {
        expect(parseNameStatusRecords('M\0scripts/foo.ts\0')).toEqual([
            { path: 'scripts/foo.ts', status: 'M' },
        ]);
    });

    it('parses an added record', () => {
        expect(parseNameStatusRecords('A\0scripts/new.ts\0')).toEqual([
            { path: 'scripts/new.ts', status: 'A' },
        ]);
    });

    it('parses a rename record with its similarity-scored status into old and new paths', () => {
        expect(parseNameStatusRecords('R100\0scripts/old.ts\0scripts/new.ts\0')).toEqual([
            { oldPath: 'scripts/old.ts', path: 'scripts/new.ts', status: 'R100' },
        ]);
    });

    it('parses multiple mixed records in one stream', () => {
        expect(
            parseNameStatusRecords(
                'M\0scripts/a.ts\0D\0scripts/b.ts\0R087\0scripts/c.ts\0scripts/d.ts\0',
            ),
        ).toEqual([
            { path: 'scripts/a.ts', status: 'M' },
            { path: 'scripts/b.ts', status: 'D' },
            { oldPath: 'scripts/c.ts', path: 'scripts/d.ts', status: 'R087' },
        ]);
    });

    it('returns nothing for empty output', () => {
        expect(parseNameStatusRecords('')).toEqual([]);
    });
});

describe('evaluateRatchet', () => {
    function candidate(overrides: Partial<RatchetCandidate>): RatchetCandidate {
        return { baseLines: 0, headLines: 0, path: 'scripts/example.ts', ...overrides };
    }

    it('fails a file that grew past the threshold', () => {
        const violations = evaluateRatchet([candidate({ baseLines: 700, headLines: 750 })]);
        expect(violations).toHaveLength(1);
        expect(violations[0]?.path).toBe('scripts/example.ts');
        expect(violations[0]?.message).toContain('750 line(s)');
        expect(violations[0]?.message).toContain('was 700 line(s)');
        expect(violations[0]?.message).toContain('Split it by responsibility');
    });

    it('passes a file that shrank, even while still above the threshold', () => {
        expect(evaluateRatchet([candidate({ baseLines: 900, headLines: 850 })])).toEqual([]);
    });

    it('passes a pure move with no content growth', () => {
        expect(
            evaluateRatchet([
                candidate({
                    baseLines: 650,
                    headLines: 650,
                    oldPath: 'scripts/old-name.ts',
                    path: 'scripts/new-name.ts',
                }),
            ]),
        ).toEqual([]);
    });

    it('fails a new file that lands at or above the threshold', () => {
        const violations = evaluateRatchet([candidate({ baseLines: 0, headLines: 650 })]);
        expect(violations).toHaveLength(1);
        expect(violations[0]?.message).toContain('was 0 line(s)');
    });

    it('fails a rename target whose pre-rename size was below the threshold and now is not', () => {
        const violations = evaluateRatchet([
            candidate({
                baseLines: 300,
                headLines: 650,
                oldPath: 'scripts/small.ts',
                path: 'scripts/grown.ts',
            }),
        ]);
        expect(violations).toHaveLength(1);
        expect(violations[0]?.message).toContain('renamed from scripts/small.ts');
    });

    it('passes a new small file below the threshold', () => {
        expect(evaluateRatchet([candidate({ baseLines: 0, headLines: 300 })])).toEqual([]);
    });

    it('passes growth that stays below the threshold', () => {
        expect(evaluateRatchet([candidate({ baseLines: 100, headLines: 300 })])).toEqual([]);
    });
});

describe('collectRatchetCandidates (real Git plumbing)', () => {
    const temporaryDirectories: string[] = [];

    afterEach(async () => {
        const pending = [...temporaryDirectories];
        temporaryDirectories.length = 0;
        await Promise.all(pending.map((path) => rm(path, { force: true, recursive: true })));
    });

    async function temporaryRepo(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'caxri-ratchet-'));
        temporaryDirectories.push(root);
        const git = (...arguments_: string[]): void => {
            execFileSync('git', arguments_, { cwd: root, stdio: 'ignore' });
        };
        git('init', '-b', 'main');
        git('config', 'user.name', 'Ratchet Test');
        git('config', 'user.email', 'ratchet@example.invalid');
        return root;
    }

    function linesOf(count: number, marker = 'x'): string {
        return `${Array.from({ length: count }, (_, index) => `// ${marker} ${index}`).join('\n')}\n`;
    }

    it('flags a tracked file that grew past the threshold since the base revision', async () => {
        const root = await temporaryRepo();
        const git = (...arguments_: string[]): void => {
            execFileSync('git', arguments_, { cwd: root, stdio: 'ignore' });
        };
        await mkdir(join(root, 'scripts'), { recursive: true });
        await writeFile(join(root, 'scripts', 'grows.ts'), linesOf(650));
        git('add', '.');
        git('commit', '-m', 'base');
        const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();

        await writeFile(join(root, 'scripts', 'grows.ts'), linesOf(700));

        const candidates = await collectRatchetCandidates(root, base);
        const violations = evaluateRatchet(candidates);
        expect(violations).toHaveLength(1);
        expect(violations[0]?.path).toBe('scripts/grows.ts');
    });

    it('does not flag a tracked file that shrank since the base revision', async () => {
        const root = await temporaryRepo();
        const git = (...arguments_: string[]): void => {
            execFileSync('git', arguments_, { cwd: root, stdio: 'ignore' });
        };
        await mkdir(join(root, 'scripts'), { recursive: true });
        await writeFile(join(root, 'scripts', 'shrinks.ts'), linesOf(900));
        git('add', '.');
        git('commit', '-m', 'base');
        const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();

        await writeFile(join(root, 'scripts', 'shrinks.ts'), linesOf(850));

        const candidates = await collectRatchetCandidates(root, base);
        expect(evaluateRatchet(candidates)).toEqual([]);
    });

    it('does not flag a pure rename Git can detect as a move, not new growth', async () => {
        const root = await temporaryRepo();
        const git = (...arguments_: string[]): void => {
            execFileSync('git', arguments_, { cwd: root, stdio: 'ignore' });
        };
        await mkdir(join(root, 'scripts'), { recursive: true });
        const content = linesOf(650, 'y');
        await writeFile(join(root, 'scripts', 'old-name.ts'), content);
        git('add', '.');
        git('commit', '-m', 'base');
        const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();

        execFileSync('git', ['mv', 'scripts/old-name.ts', 'scripts/new-name.ts'], { cwd: root });

        const candidates = await collectRatchetCandidates(root, base);
        expect(evaluateRatchet(candidates)).toEqual([]);
        const moved = candidates.find((candidate) => candidate.path === 'scripts/new-name.ts');
        expect(moved?.oldPath).toBe('scripts/old-name.ts');
        expect(moved?.headLines).toBe(moved?.baseLines);
    });

    it('flags a new untracked file that starts at or above the threshold', async () => {
        const root = await temporaryRepo();
        const git = (...arguments_: string[]): void => {
            execFileSync('git', arguments_, { cwd: root, stdio: 'ignore' });
        };
        await mkdir(join(root, 'scripts'), { recursive: true });
        await writeFile(join(root, 'scripts', 'placeholder.ts'), 'export const placeholder = 1;\n');
        git('add', '.');
        git('commit', '-m', 'base');
        const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();

        await writeFile(join(root, 'scripts', 'brand-new.ts'), linesOf(RATCHET_LINE_THRESHOLD));

        const candidates = await collectRatchetCandidates(root, base);
        const violations = evaluateRatchet(candidates);
        expect(violations).toHaveLength(1);
        expect(violations[0]?.path).toBe('scripts/brand-new.ts');
        expect(violations[0]?.message).toContain('was 0 line(s)');
    });

    it('ignores paths outside the ratcheted roots and extensions entirely', async () => {
        const root = await temporaryRepo();
        const git = (...arguments_: string[]): void => {
            execFileSync('git', arguments_, { cwd: root, stdio: 'ignore' });
        };
        await mkdir(join(root, 'docs'), { recursive: true });
        await writeFile(join(root, 'docs', 'notes.md'), 'seed\n');
        git('add', '.');
        git('commit', '-m', 'base');
        const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();

        await writeFile(join(root, 'docs', 'notes.md'), linesOf(900));

        const candidates = await collectRatchetCandidates(root, base);
        expect(candidates).toEqual([]);
    });
});
