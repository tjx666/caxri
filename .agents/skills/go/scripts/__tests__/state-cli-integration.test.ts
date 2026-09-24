import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { acquireMutationLease } from '../mutation-lease';
import { PLATFORM_NEUTRAL_CI_COMMANDS } from '../platform-neutral-gates';
import { createReviewPolicy, recordReviewDecision } from '../review-gate';
import type * as reviewHeadReconciliationModule from '../review-head-reconciliation';
import { runStateCli, stateCliHelp } from '../state-cli';
import { addEvent, createInitialState, transitionState } from '../state-model';
import {
    prepareRunDirectory,
    readState,
    statePathForRunId,
    writeInitialState,
    writeState,
} from '../state-storage';

const cleanupPaths: string[] = [];
const reviewValidationHook = vi.hoisted((): { afterInitialCheck?: () => Promise<void> } => ({}));

vi.mock('../review-head-reconciliation', async (importOriginal) => {
    const actual = await importOriginal<typeof reviewHeadReconciliationModule>();
    return {
        ...actual,
        assertReviewHeadMatchesWorktree: async (
            ...arguments_: Parameters<typeof actual.assertReviewHeadMatchesWorktree>
        ) => {
            const result = await actual.assertReviewHeadMatchesWorktree(...arguments_);
            await reviewValidationHook.afterInitialCheck?.();
            return result;
        },
    };
});

afterEach(async () => {
    reviewValidationHook.afterInitialCheck = undefined;
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

function reviewArguments(statePath: string, headSha: string, reviewedRange: string) {
    return [
        'review',
        '--state',
        statePath,
        '--head-sha',
        headSha,
        '--mode',
        'light',
        '--p0',
        '0',
        '--p1',
        '0',
        '--scope',
        'CLI review fixture',
        '--reviewed-range',
        reviewedRange,
        '--freeze',
    ];
}

describe('Go state CLI exact-head receipts', () => {
    it('records a fake exact-head CI source for a full review without local gate receipts', async () => {
        const { headSha, statePath } = await fixture();
        const state = await readState(statePath);
        transitionState(state, 'planning');
        transitionState(state, 'issue_execution');
        transitionState(state, 'deep_review');
        await writeState(statePath, state);

        await runStateCli(
            [
                'review',
                '--state',
                statePath,
                '--head-sha',
                headSha,
                '--mode',
                'full',
                '--p0',
                '0',
                '--p1',
                '0',
                '--scope',
                'CI receipt fixture',
                '--reviewed-range',
                `origin/main...${headSha}`,
            ],
            {
                readCiPlatformReceipt: (requestedHead) =>
                    Promise.resolve({
                        commands: [...PLATFORM_NEUTRAL_CI_COMMANDS],
                        headSha: requestedHead,
                        runId: 42,
                        runUrl: 'https://github.com/tjx666/caxri/actions/runs/42',
                    }),
            },
        );

        expect((await readState(statePath)).reviewGate.rounds[0].platformGateReceipt).toMatchObject(
            { source: 'ci', ciRunId: 42, ciCommands: PLATFORM_NEUTRAL_CI_COMMANDS },
        );
    });

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

    it('requires ordinary reviews to name the clean canonical worktree HEAD', async () => {
        const { headSha, statePath, worktree } = await fixture();
        const missingHead = 'f'.repeat(40);
        await expect(
            runStateCli(reviewArguments(statePath, missingHead, 'origin/main...missing')),
        ).rejects.toThrow('git exited');

        await writeFile(join(worktree, 'source.ts'), 'export const value = 2;\n', 'utf8');
        execFileSync('git', ['add', '.'], { cwd: worktree });
        execFileSync('git', ['commit', '-qm', 'second'], { cwd: worktree });
        const currentHead = execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: worktree,
            encoding: 'utf8',
        }).trim();
        await expect(
            runStateCli(reviewArguments(statePath, headSha, `origin/main...${headSha}`)),
        ).rejects.toThrow('canonical current worktree HEAD');

        await writeFile(join(worktree, 'source.ts'), 'export const value = 3;\n', 'utf8');
        await expect(
            runStateCli(reviewArguments(statePath, currentHead, `origin/main...${currentHead}`)),
        ).rejects.toThrow('clean recorded worktree');
        expect((await readState(statePath)).reviewGate.rounds).toHaveLength(0);
    });

    it('refuses ordinary review during mutation or when HEAD moves before persistence', async () => {
        const { headSha, statePath, worktree } = await fixture();
        const state = await readState(statePath);
        transitionState(state, 'planning');
        transitionState(state, 'issue_execution');
        transitionState(state, 'deep_review');
        state.reviewPolicy = createReviewPolicy('light', 'test policy');
        acquireMutationLease(state, { holderId: 'repair', kind: 'repair' });
        await writeState(statePath, state);

        await expect(
            runStateCli(reviewArguments(statePath, headSha, `origin/main...${headSha}`)),
        ).rejects.toThrow('no active mutation lease');
        expect((await readState(statePath)).reviewGate.rounds).toHaveLength(0);

        const unlocked = await readState(statePath);
        unlocked.mutationLease = null;
        await writeState(statePath, unlocked);
        reviewValidationHook.afterInitialCheck = async () => {
            await writeFile(join(worktree, 'source.ts'), 'export const value = 2;\n', 'utf8');
            execFileSync('git', ['add', '.'], { cwd: worktree });
            execFileSync('git', ['commit', '-qm', 'concurrent change'], { cwd: worktree });
        };

        await expect(
            runStateCli(reviewArguments(statePath, headSha, `origin/main...${headSha}`)),
        ).rejects.toThrow('changed before review could be persisted');
        expect((await readState(statePath)).reviewGate.rounds).toHaveLength(0);
    });

    it('reconciles one unconsumed missing review head without reviewing dirty tooling', async () => {
        const { headSha: parentHead, statePath, worktree } = await fixture();
        await writeFile(join(worktree, 'source.ts'), 'export const value = 2;\n', 'utf8');
        execFileSync('git', ['add', '.'], { cwd: worktree });
        execFileSync('git', ['commit', '-qm', 'reviewed repair'], { cwd: worktree });
        const actualHead = execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: worktree,
            encoding: 'utf8',
        }).trim();
        const state = await readState(statePath);
        transitionState(state, 'planning');
        transitionState(state, 'issue_execution');
        transitionState(state, 'deep_review');
        state.reviewPolicy = createReviewPolicy('light', 'test policy');
        recordReviewDecision(state, {
            freeze: false,
            headSha: parentHead,
            mode: 'light',
            p0: 0,
            p1: 0,
            reviewedRange: `origin/main...${parentHead}`,
            scope: 'Baseline',
        });
        const missingHead = 'f'.repeat(40);
        recordReviewDecision(state, {
            baselineHeadSha: parentHead,
            baselineReviewId: 'review-001',
            freeze: true,
            headSha: missingHead,
            mode: 'light',
            p0: 0,
            p1: 0,
            parentReviewId: 'review-001',
            reviewedRange: `${parentHead}..${missingHead}`,
            scope: 'Reviewed repair',
        });
        addEvent(state, 'review', `review-002 light ${parentHead}..${missingHead}`);
        transitionState(state, 'delivery');
        await writeState(statePath, state);
        await writeFile(join(worktree, 'tooling.ts'), 'export const tooling = true;\n', 'utf8');

        await expect(
            runStateCli([
                'review-reconcile-head',
                '--state',
                statePath,
                '--review-id',
                'review-002',
                '--reason',
                'The typed full SHA did not resolve.',
            ]),
        ).resolves.toBeUndefined();

        const reconciled = await readState(statePath);
        expect(reconciled.reviewGate).toMatchObject({
            frozenHeadSha: actualHead,
            rounds: [
                expect.objectContaining({ headSha: parentHead, id: 'review-001' }),
                expect.objectContaining({
                    headSha: actualHead,
                    id: 'review-002',
                    reviewedRange: `${parentHead}..${actualHead}`,
                    scope: 'Reviewed repair',
                }),
            ],
        });
        const audit = reconciled.events.findLast(
            ({ type }) => type === 'review_head_reconciliation',
        );
        expect(JSON.parse(audit!.detail)).toMatchObject({
            actualHeadSha: actualHead,
            correctedRange: `${parentHead}..${actualHead}`,
            original: {
                headSha: missingHead,
                id: 'review-002',
                reviewedRange: `${parentHead}..${missingHead}`,
                scope: 'Reviewed repair',
            },
        });
        expect(
            execFileSync('git', ['status', '--porcelain'], {
                cwd: worktree,
                encoding: 'utf8',
            }),
        ).toContain('tooling.ts');
    });
});
