import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { mobileChangesPaths, seedMobileChangesFixture } from './mobile-changes-fixture';

const execFileAsync = promisify(execFile);

async function withSyntheticProject(
    kind: 'standard' | 'limits',
    verify: (root: string) => Promise<void>,
): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), 'caxri-mobile-changes-test-'));
    try {
        await seedMobileChangesFixture(root, kind);
        await verify(root);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
}

describe('synthetic mobile Changes Project', () => {
    it('shows exactly one modified, added, and deleted path', async () => {
        await withSyntheticProject('standard', async (root) => {
            const { stdout } = await execFileAsync('git', ['status', '--short'], { cwd: root });
            expect(stdout.trimEnd().split('\n')).toEqual([
                ` M ${mobileChangesPaths.modified}`,
                ` D ${mobileChangesPaths.deleted}`,
                `?? ${mobileChangesPaths.added}`,
            ]);
            expect(
                (await readFile(join(root, mobileChangesPaths.modified), 'utf8')).length,
            ).toBeGreaterThan(700);
        });
    });

    it('adds a binary change and a text diff above the 48 KiB mobile bound', async () => {
        await withSyntheticProject('limits', async (root) => {
            const binary = await readFile(join(root, mobileChangesPaths.binary));
            expect(binary.includes(0)).toBe(true);
            expect((await stat(join(root, mobileChangesPaths.oversized))).size).toBeGreaterThan(
                48 * 1_024,
            );
            const { stdout } = await execFileAsync('git', ['status', '--short'], { cwd: root });
            expect(stdout.trimEnd().split('\n')).toEqual([
                ` M ${mobileChangesPaths.binary}`,
                ` M ${mobileChangesPaths.oversized}`,
            ]);
        });
    });
});
