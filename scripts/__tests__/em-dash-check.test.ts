import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { collectEmDashFindings, findEmDashes } from '../em-dash-check';

const EM_DASH = '\u{2014}';

describe('findEmDashes', () => {
    it('reports the path, line, and 1-based column of a prose em-dash', () => {
        expect(
            findEmDashes(`docs/a.md:3:Create files lazily ${EM_DASH} only when needed.`),
        ).toEqual({
            column: 21,
            line: 3,
            path: 'docs/a.md',
            text: `Create files lazily ${EM_DASH} only when needed.`,
        });
    });

    it('allows the quoted empty-value placeholder glyph in every quote style', () => {
        for (const quote of ["'", '"', '`']) {
            expect(findEmDashes(`a.tsx:1:value={x ?? ${quote}${EM_DASH}${quote}}`)).toBeUndefined();
        }
    });

    it('still reports prose on a line that also carries the placeholder glyph', () => {
        expect(
            findEmDashes(`a.ts:1:const v = x ?? '${EM_DASH}'; // empty ${EM_DASH} no data`),
        ).toMatchObject({ line: 1, path: 'a.ts' });
    });

    it('does not treat a placeholder-like literal with surrounding text as allowed', () => {
        expect(findEmDashes(`a.ts:1:const label = '${EM_DASH} none';`)).toBeDefined();
    });
});

describe('collectEmDashFindings', () => {
    let repoRoot: string | undefined;

    afterEach(async () => {
        if (repoRoot) await rm(repoRoot, { force: true, recursive: true });
        repoRoot = undefined;
    });

    async function createRepo(files: Record<string, string>): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'em-dash-check-'));
        execFileSync('git', ['init', '-q'], { cwd: root });
        await Promise.all(
            Object.entries(files).map(async ([path, content]) => {
                await mkdir(join(root, path, '..'), { recursive: true });
                await writeFile(join(root, path), content);
            }),
        );
        execFileSync('git', ['add', '.'], { cwd: root });
        return root;
    }

    it('passes a repository without em-dashes', async () => {
        repoRoot = await createRepo({ 'README.md': 'Plain prose: no dashes.\n' });
        await expect(collectEmDashFindings(repoRoot)).resolves.toEqual([]);
    });

    it('reports tracked prose and skips vendored licenses and tools', async () => {
        repoRoot = await createRepo({
            'docs/guide.md': `One ${EM_DASH} two\n`,
            'licenses/third-party.txt': `Vendor ${EM_DASH} text\n`,
            'src/empty.ts': `export const empty = '${EM_DASH}';\n`,
            'tools/vendored/readme.md': `Vendor ${EM_DASH} text\n`,
        });
        const findings = await collectEmDashFindings(repoRoot);
        expect(findings.map((finding) => finding.path)).toEqual(['docs/guide.md']);
    });
});
