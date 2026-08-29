import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it } from 'vitest';

import { runStateCli, stateCliHelp } from '../state-cli';
import { createInitialState } from '../state-model';
import {
    prepareRunDirectory,
    readState,
    statePathForRunId,
    writeInitialState,
} from '../state-storage';

const cleanupPaths: string[] = [];

afterEach(async () => {
    const paths = [...cleanupPaths];
    cleanupPaths.length = 0;
    await Promise.all(paths.map((path) => rm(path, { force: true, recursive: true })));
});

async function fixture() {
    const worktree = await mkdtemp(join(tmpdir(), 'caxri-go-cli-worktree-'));
    cleanupPaths.push(worktree);
    execFileSync('git', ['init', '-q'], { cwd: worktree });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: worktree });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: worktree });
    await writeFile(join(worktree, '.gitignore'), 'ignored/\n', 'utf8');
    await writeFile(join(worktree, 'source.ts'), 'export const value = 1;\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: worktree });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: worktree });
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: worktree,
        encoding: 'utf8',
    }).trim();
    const runId = `cli-integrity-${Date.now()}-${process.pid}`;
    const statePath = statePathForRunId(runId);
    cleanupPaths.push(dirname(statePath));
    await prepareRunDirectory(statePath);
    await writeInitialState(
        statePath,
        createInitialState({
            objective: 'Verify exact-head CLI receipts',
            runId,
            worktree: {
                baseSha: headSha,
                createdAt: '2026-08-14T00:00:00.000Z',
                mainCheckoutPath: `${worktree}-main`,
                path: worktree,
            },
        }),
    );
    return { headSha, statePath, worktree };
}

function validationRun(
    statePath: string,
    lineageId: string,
    script: string,
    expectedHead?: string,
) {
    return runStateCli([
        'validation-run',
        '--state',
        statePath,
        '--kind',
        'gates',
        '--lineage-id',
        lineageId,
        ...(expectedHead ? ['--head-sha', expectedHead] : []),
        '--session-id',
        lineageId,
        '--',
        process.execPath,
        '-e',
        script,
    ]);
}

describe('Go state CLI exact-head receipts', () => {
    it('reserves round changes for publication or explicit reconciliation', () => {
        expect(stateCliHelp('acceptance')).not.toContain('--round');
        expect(stateCliHelp('acceptance-reconcile-round')).toContain('--round');
    });

    it('rejects manual Acceptance round advancement before mutating the ledger', async () => {
        const { statePath } = await fixture();

        await expect(
            runStateCli([
                'acceptance',
                '--state',
                statePath,
                '--status',
                'running',
                '--round',
                '1',
            ]),
        ).rejects.toThrow('acceptance-publish owns round advancement');

        expect((await readState(statePath)).acceptance).toMatchObject({
            round: 0,
            status: 'not_started',
        });
    });

    it('self-resolves HEAD, ignores ignored output, and fails closed on source mutation', async () => {
        const { headSha, statePath } = await fixture();
        await expect(validationRun(statePath, 'forged', '', 'not-the-head')).rejects.toThrow(
            'recorded worktree is',
        );
        expect((await readState(statePath)).validations).toHaveLength(0);

        await expect(
            validationRun(
                statePath,
                'clean',
                String.raw`require('node:fs').mkdirSync('ignored', { recursive: true }); require('node:fs').writeFileSync('ignored/build.log', 'generated\n')`,
                headSha,
            ),
        ).resolves.toBe(0);
        expect((await readState(statePath)).validations[0].result).toBe('passed');

        await expect(
            validationRun(
                statePath,
                'mutated',
                String.raw`require('node:fs').writeFileSync('source.ts', 'export const value = 2;\n')`,
            ),
        ).resolves.toBe(0);
        const failed = (await readState(statePath)).validations[1];
        expect(failed.integrityError).toContain('fingerprint changed');
        expect(failed.result).toBe('failed');
    });
});
