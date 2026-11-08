import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { checkLinksAndPaths, defaultCheckedFiles } from '../documentation-check';

const temporaryDirectories: string[] = [];

async function createRepoRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'caxri-documentation-check-skills-'));
    temporaryDirectories.push(root);
    return root;
}

async function writeRepoFile(repoRoot: string, relativePath: string, content: string) {
    const absolutePath = join(repoRoot, relativePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, 'utf8');
}

afterEach(async () => {
    const directories = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(
        directories.map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

describe('checkLinksAndPaths for skill Markdown', () => {
    it('fails a backticked repository path that does not exist', async () => {
        const repoRoot = await createRepoRoot();
        const issues = await checkLinksAndPaths({
            relativePath: '.agents/skills/demo/SKILL.md',
            repoRoot,
            source: 'See `apps/server/src/gone.ts` for details.\n',
        });
        expect(issues.map((issue) => issue.message)).toEqual([
            'backticked repository path does not exist: apps/server/src/gone.ts',
        ]);
    });

    it('resolves a skill-relative path against the skill directory', async () => {
        const repoRoot = await createRepoRoot();
        await writeRepoFile(repoRoot, '.agents/skills/demo/scripts/sync.sh', '#!/bin/sh\n');
        const issues = await checkLinksAndPaths({
            relativePath: '.agents/skills/demo/references/notes.md',
            repoRoot,
            source: 'Run `scripts/sync.sh`.\n',
        });
        expect(issues).toEqual([]);
    });

    it('still fails a skill-relative path whose file is missing', async () => {
        const repoRoot = await createRepoRoot();
        const issues = await checkLinksAndPaths({
            relativePath: '.agents/skills/demo/SKILL.md',
            repoRoot,
            source: 'Run `scripts/missing.sh`.\n',
        });
        expect(issues).toHaveLength(1);
    });

    it('exempts competitors references that cite external repositories', async () => {
        const repoRoot = await createRepoRoot();
        const issues = await checkLinksAndPaths({
            relativePath: '.agents/skills/competitors/references/orca.md',
            repoRoot,
            source: 'Orca keeps `apps/desktop/src/other-repo-only.ts`.\n',
        });
        expect(issues).toEqual([]);
    });

    it('includes skill Markdown in the default checked file set', async () => {
        const repoRoot = await createRepoRoot();
        await writeRepoFile(repoRoot, '.agents/skills/demo/SKILL.md', 'x\n');
        await writeRepoFile(repoRoot, 'skills/product/SKILL.md', 'x\n');
        const files = await defaultCheckedFiles(repoRoot);
        expect(files).toEqual(
            expect.arrayContaining(['.agents/skills/demo/SKILL.md', 'skills/product/SKILL.md']),
        );
    });
});
