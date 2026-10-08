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

    it('allows em-dashes in code string literals and JSX text', () => {
        for (const line of [
            `a.ts:1:const empty = '${EM_DASH}';`,
            `a.ts:1:return \`\${label} ${EM_DASH} \${message}\`;`,
            `a.tsx:1:<p>No running Agent ${EM_DASH} copy the report instead.</p>`,
            `a.html:1:<title>Process Explorer ${EM_DASH} Caxri</title>`,
            `a.ts:1:const url = 'https://example.com'; const t = 'A ${EM_DASH} B';`,
        ]) {
            expect(findEmDashes(line)).toBeUndefined();
        }
    });

    it('reports em-dashes in code comments', () => {
        for (const line of [
            `a.ts:1:// Lazily ${EM_DASH} only when needed.`,
            `a.ts:1: * JSDoc ${EM_DASH} continuation`,
            `a.ts:1:/** Block ${EM_DASH} opener */`,
            `a.tsx:1:{/* JSX ${EM_DASH} comment */}`,
            `a.html:1:<!-- Markup ${EM_DASH} comment -->`,
        ]) {
            expect(findEmDashes(line)).toMatchObject({ line: 1 });
        }
    });

    it('reports a trailing comment after a string that also carries an em-dash', () => {
        expect(
            findEmDashes(`a.ts:1:const v = x ?? '${EM_DASH}'; // empty ${EM_DASH} no data`),
        ).toMatchObject({
            column: 30,
        });
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

    it('reports tracked prose and skips code strings, vendored licenses, and tools', async () => {
        repoRoot = await createRepo({
            'docs/guide.md': `One ${EM_DASH} two\n`,
            'licenses/third-party.txt': `Vendor ${EM_DASH} text\n`,
            'src/copy.ts': `export const title = 'Process Explorer ${EM_DASH} Caxri';\n`,
            'tools/vendored/readme.md': `Vendor ${EM_DASH} text\n`,
        });
        const findings = await collectEmDashFindings(repoRoot);
        expect(findings.map((finding) => finding.path)).toEqual(['docs/guide.md']);
    });
});
