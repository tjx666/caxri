import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    commandCapture,
    publishAcceptanceRound,
    recordOrphanedAcceptance,
    recordPublishedAcceptance,
    restartAcceptanceLineage,
} from '../acceptance-publication';
import { createResumeCheckpoint } from '../resume';
import { createInitialState, recordPullRequest } from '../state-model';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const TEST_ROOT = join(
    PROJECT_ROOT,
    '.records',
    '__test__',
    `acceptance-publication-${process.pid}`,
);

function publicationState(runId: string, headSha = 'head-1') {
    const state = createInitialState({ objective: 'Publish Acceptance', runId });
    state.phase = 'acceptance';
    state.status = 'active';
    state.pullRequest.headSha = headSha;
    return state;
}

function report(
    headSha: string,
    checkIds = ['acceptance-round-lineage'],
    verdict: 'fail' | 'partial' | 'pass' = 'pass',
) {
    return {
        cases: checkIds.map((id) => ({ evidence: [`assets/${id}.txt`], id, surface: 'desktop' })),
        commit: headSha,
        createdAt: '2026-08-12T00:00:00.000Z',
        plan: checkIds.map((id) => ({ id, requiredEvidence: ['text'], surface: 'desktop' })),
        requirement: '同一交付只保留一个稳定的 Acceptance lineage。',
        summary: { verdict },
    };
}

async function writeRound(
    round: number,
    headSha: string,
    checkIds?: string[],
    verdict?: 'fail' | 'partial' | 'pass',
): Promise<string> {
    const directory = join(TEST_ROOT, `round-${round}`);
    await mkdir(directory, { recursive: true });
    await writeFile(
        join(directory, 'result.json'),
        `${JSON.stringify(report(headSha, checkIds, verdict), null, 2)}\n`,
    );
    return directory;
}

async function writeRoundWithVisualEvidence(): Promise<string> {
    const directory = join(TEST_ROOT, 'round-1');
    await mkdir(join(directory, 'assets'), { recursive: true });
    await writeFile(join(directory, 'assets', 'desktop.png'), 'visual evidence');
    await writeFile(
        join(directory, 'result.json'),
        `${JSON.stringify(
            {
                cases: [
                    {
                        evidence: ['assets/desktop.png'],
                        id: 'desktop-visual-state',
                        surface: 'desktop',
                    },
                ],
                commit: 'head-1',
                createdAt: '2026-08-12T00:00:00.000Z',
                plan: [
                    {
                        id: 'desktop-visual-state',
                        requiredEvidence: [
                            { hint: 'Capture the rendered desktop surface', type: 'screenshot' },
                        ],
                        surface: 'desktop',
                    },
                ],
                requirement: '桌面视觉结果必须随 Acceptance 报告交付。',
                summary: { verdict: 'pass' },
            },
            null,
            2,
        )}\n`,
    );
    return directory;
}

function ingestJson(roundIndex: number, acceptanceId = 'acc-1', verifyRunId = `run-${roundIndex}`) {
    return JSON.stringify({ acceptanceId, roundIndex, verifyRunId });
}

function runListJson(input?: {
    acceptanceId?: string;
    checkIds?: string[];
    headSha?: string;
    roundIndex?: number;
    verifyRunId?: string;
}) {
    if (!input) return '[]';
    const roundIndex = input.roundIndex ?? 1;
    return JSON.stringify([
        {
            acceptanceId: input.acceptanceId ?? 'acc-1',
            context: {
                commit: input.headSha ?? 'head-1',
                testedAt: '2026-08-12T00:00:00.000Z',
            },
            id: input.verifyRunId ?? `run-${roundIndex}`,
            plan: (input.checkIds ?? ['acceptance-round-lineage']).map((id) => ({ id })),
            roundIndex,
            source: 'agent-testing',
        },
    ]);
}

function viewJson(
    input: {
        acceptanceId?: string;
        checkIds?: string[];
        evidence?: Array<{
            content?: string | null;
            fileId?: string | null;
            fileUrl?: string | null;
            type: 'dom_snapshot' | 'gif' | 'markdown' | 'screenshot' | 'text' | 'video';
        }>;
        headSha?: string;
        /**
         * Older shape: `checks[].id` is the stable id and `planItem` is absent.
         */
        legacyCheckShape?: boolean;
        roundIndex?: number;
        surface?: 'desktop' | 'mobile';
        verdict?: 'failed' | 'passed' | 'uncertain';
        verifyRunId?: string;
    } = {},
) {
    const acceptanceId = input.acceptanceId ?? 'acc-1';
    const roundIndex = input.roundIndex ?? 1;
    const verifyRunId = input.verifyRunId ?? `run-${roundIndex}`;
    return JSON.stringify({
        acceptance: { id: acceptanceId },
        // Exercise the current and legacy response shapes used by the compatibility parser.
        checks: (input.checkIds ?? ['acceptance-round-lineage']).map((id, index) => ({
            evidence: input.evidence ?? [
                { content: 'Remote evidence receipt', fileId: null, fileUrl: null, type: 'text' },
            ],
            id: input.legacyCheckShape ? id : `server-uuid-${index}`,
            ...(!input.legacyCheckShape && {
                planItem: { id, verifierConfig: { surface: input.surface ?? 'desktop' } },
            }),
            resultRound: roundIndex,
            surface: input.surface ?? 'desktop',
        })),
        rounds: [
            {
                report: { verdict: input.verdict ?? 'passed' },
                run: {
                    acceptanceId,
                    context: { commit: input.headSha ?? `head-${roundIndex}` },
                    id: verifyRunId,
                    roundIndex,
                },
            },
        ],
    });
}

describe('Go Acceptance round publication', () => {
    beforeEach(async () => {
        await rm(TEST_ROOT, { force: true, recursive: true });
    });

    afterAll(async () => {
        await rm(TEST_ROOT, { force: true, recursive: true });
    });

    it.each([false, true])(
        'creates round one and freezes the lineage (legacy=%s)',
        async (legacy) => {
            const state = publicationState('publish-one');
            const directory = await writeRound(1, 'head-1');
            const runner = vi
                .fn()
                .mockResolvedValueOnce(runListJson())
                .mockResolvedValueOnce(ingestJson(1))
                .mockResolvedValueOnce(viewJson({ legacyCheckShape: legacy }));

            await expect(
                publishAcceptanceRound(
                    state,
                    { headSha: 'head-1', reportDirectory: directory },
                    runner,
                ),
            ).resolves.toMatchObject({
                acceptanceId: 'acc-1',
                headSha: 'head-1',
                roundIndex: 1,
                verifyRunId: 'run-1',
            });

            expect(runner.mock.calls[1][1]).toEqual(
                expect.arrayContaining(['--requirement', report('head-1').requirement]),
            );
            expect(runner.mock.calls[1][1]).not.toContain('--acceptance');
            expect(runner.mock.calls[1][2]).toBe(10 * 60_000);
            expect(state.acceptance).toMatchObject({
                id: 'acc-1',
                round: 1,
                status: 'pending',
                url: 'https://app.lobehub.com/acceptance/acc-1',
            });
            expect(state.acceptance.publication.history).toHaveLength(1);
            expect(createResumeCheckpoint(state).acceptance.publication.history[0]).toMatchObject({
                acceptanceId: 'acc-1',
                roundIndex: 1,
                verifyRunId: 'run-1',
            });
        },
    );

    it('rejects a remote round that dropped required visual evidence', async () => {
        const state = publicationState('missing-visual-evidence');
        const directory = await writeRoundWithVisualEvidence();
        const runner = vi
            .fn()
            .mockResolvedValueOnce(runListJson())
            .mockResolvedValueOnce(ingestJson(1))
            .mockResolvedValueOnce(
                viewJson({ checkIds: ['desktop-visual-state'], headSha: 'head-1' }),
            );

        await expect(
            publishAcceptanceRound(
                state,
                { headSha: 'head-1', reportDirectory: directory },
                runner,
            ),
        ).rejects.toThrow('evidence');
        expect(state.acceptance.publication.history).toEqual([]);
    });

    it('rejects visual evidence that has a file record but no renderable URL', async () => {
        const state = publicationState('missing-visual-url');
        const directory = await writeRoundWithVisualEvidence();
        const runner = vi
            .fn()
            .mockResolvedValueOnce(runListJson())
            .mockResolvedValueOnce(ingestJson(1))
            .mockResolvedValueOnce(
                viewJson({
                    checkIds: ['desktop-visual-state'],
                    evidence: [
                        { content: null, fileId: 'file-1', fileUrl: null, type: 'screenshot' },
                    ],
                    headSha: 'head-1',
                }),
            );

        await expect(
            publishAcceptanceRound(
                state,
                { headSha: 'head-1', reportDirectory: directory },
                runner,
            ),
        ).rejects.toThrow('payload is missing');
        expect(state.acceptance.publication.history).toEqual([]);
    });

    it('accepts visual evidence only when the remote round has a renderable file', async () => {
        const state = publicationState('renderable-visual-evidence');
        const directory = await writeRoundWithVisualEvidence();
        const runner = vi
            .fn()
            .mockResolvedValueOnce(runListJson())
            .mockResolvedValueOnce(ingestJson(1))
            .mockResolvedValueOnce(
                viewJson({
                    checkIds: ['desktop-visual-state'],
                    evidence: [
                        {
                            content: null,
                            fileId: 'file-1',
                            fileUrl: 'https://example.com/desktop.png',
                            type: 'screenshot',
                        },
                    ],
                    headSha: 'head-1',
                }),
            );

        await expect(
            publishAcceptanceRound(
                state,
                { headSha: 'head-1', reportDirectory: directory },
                runner,
            ),
        ).resolves.toMatchObject({ acceptanceId: 'acc-1', roundIndex: 1 });
    });

    it('invalidates a pending publication when the pull request head changes', async () => {
        const state = publicationState('replacement-head');
        recordPublishedAcceptance(state, {
            acceptanceId: 'acc-1',
            checkIds: ['acceptance-round-lineage'],
            headSha: 'head-1',
            publishedAt: '2026-08-12T00:00:00.000Z',
            roundIndex: 1,
            url: 'https://app.lobehub.com/acceptance/acc-1',
            verdict: 'pass',
            verifyRunId: 'run-1',
        });
        state.acceptance.publication.pendingAttempt = {
            acceptanceId: 'acc-1',
            checkIds: ['acceptance-round-lineage'],
            createdAt: '2026-08-12T01:00:00.000Z',
            headSha: 'head-1',
            reportPath: '.records/go/replacement-head/acceptance/round-2',
            roundIndex: 2,
            verdict: 'pass',
            verifyRunId: 'run-stale',
        };

        recordPullRequest(state, { headSha: 'head-2', status: 'checks_pending' });

        expect(state.acceptance).toMatchObject({
            acceptedHeadSha: null,
            id: 'acc-1',
            round: 1,
            status: 'not_started',
            waivedHeadSha: null,
            waiverReason: null,
        });
        expect(state.acceptance.publication.history).toHaveLength(1);
        expect(state.acceptance.publication.pendingAttempt).toBeNull();

        const directory = await writeRound(2, 'head-2');
        const runner = vi
            .fn()
            .mockResolvedValueOnce(runListJson())
            .mockResolvedValueOnce(ingestJson(2))
            .mockResolvedValueOnce(viewJson({ headSha: 'head-2', roundIndex: 2 }));
        await expect(
            publishAcceptanceRound(
                state,
                { headSha: 'head-2', reportDirectory: directory },
                runner,
            ),
        ).resolves.toMatchObject({ headSha: 'head-2', roundIndex: 2 });
    });

    it('preserves a replaced-head standalone publication as orphaned history', () => {
        const state = publicationState('replacement-standalone');
        state.acceptance.publication.pendingAttempt = {
            acceptanceId: 'acc-standalone',
            checkIds: ['acceptance-round-lineage'],
            createdAt: '2026-08-12T01:00:00.000Z',
            headSha: 'head-1',
            reportPath: '.records/go/replacement-standalone/acceptance/round-1',
            roundIndex: 1,
            verdict: 'pass',
            verifyRunId: 'run-standalone',
        };

        recordPullRequest(state, { headSha: 'head-2', status: 'checks_pending' });

        expect(state.acceptance.publication.pendingAttempt).toBeNull();
        expect(state.acceptance.publication.orphanedStandalones).toEqual([
            expect.objectContaining({
                acceptanceId: 'acc-standalone',
                verifyRunId: 'run-standalone',
            }),
        ]);
    });

    it('bounds a stalled external publication command', async () => {
        await expect(
            commandCapture(
                process.execPath,
                ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
                50,
                10,
            ),
        ).rejects.toThrow('timed out after 50ms');
    });

    it('forces every later round to append to the frozen Acceptance id', async () => {
        const state = publicationState('publish-two');
        await writeRound(1, 'head-1');
        await publishAcceptanceRound(
            state,
            {
                headSha: 'head-1',
                reportDirectory: join(TEST_ROOT, 'round-1'),
            },
            vi
                .fn()
                .mockResolvedValueOnce(runListJson())
                .mockResolvedValueOnce(ingestJson(1))
                .mockResolvedValueOnce(viewJson()),
        );
        state.pullRequest.headSha = 'head-2';
        const directory = await writeRound(2, 'head-2');
        const runner = vi
            .fn()
            .mockResolvedValueOnce(runListJson())
            .mockResolvedValueOnce(ingestJson(2))
            .mockResolvedValueOnce(viewJson({ headSha: 'head-2', roundIndex: 2 }));

        await publishAcceptanceRound(
            state,
            { headSha: 'head-2', reportDirectory: directory },
            runner,
        );

        const ingestArguments = runner.mock.calls[1][1] as string[];
        expect(ingestArguments.slice(ingestArguments.indexOf('--acceptance'), -1)).toContain(
            'acc-1',
        );
        expect(state.acceptance.publication.history.map(({ roundIndex }) => roundIndex)).toEqual([
            1, 2,
        ]);
    });

    it('matches a fixture-blocked partial report to the remote uncertain verdict', async () => {
        const state = publicationState('partial');
        const directory = await writeRound(1, 'head-1', undefined, 'partial');
        const runner = vi
            .fn()
            .mockResolvedValueOnce(runListJson())
            .mockResolvedValueOnce(ingestJson(1))
            .mockResolvedValueOnce(viewJson({ verdict: 'uncertain' }));

        await expect(
            publishAcceptanceRound(
                state,
                { headSha: 'head-1', reportDirectory: directory },
                runner,
            ),
        ).resolves.toMatchObject({ verdict: 'partial' });
    });

    it('rejects a round that is not bound to the current PR head before ingest', async () => {
        const state = publicationState('stale-head', 'current-head');
        const directory = await writeRound(1, 'stale-head');
        const runner = vi.fn();

        await expect(
            publishAcceptanceRound(
                state,
                { headSha: 'stale-head', reportDirectory: directory },
                runner,
            ),
        ).rejects.toThrow('exact current PR head');
        expect(runner).not.toHaveBeenCalled();
    });

    it.each([
        ['empty ingest output', '', runListJson(), 'empty JSON output'],
        ['wrong acceptance id', ingestJson(1, 'acc-wrong'), viewJson(), 'different Acceptance'],
        ['wrong round', ingestJson(2), viewJson(), 'unexpected round index'],
        [
            'wrong readback head',
            ingestJson(1),
            viewJson({ headSha: 'wrong-head' }),
            'does not match the exact head',
        ],
        [
            'wrong readback checks',
            ingestJson(1),
            viewJson({ checkIds: ['different-check'] }),
            'check ids do not match',
        ],
        [
            'wrong readback verdict',
            ingestJson(1),
            viewJson({ verdict: 'failed' }),
            'verdict does not match',
        ],
    ] as const)('fails closed for %s', async (_name, ingest, afterIngest, expected) => {
        const state = publicationState('publish-fail');
        const directory = await writeRound(1, 'head-1');
        if (_name === 'wrong acceptance id') state.acceptance.id = 'acc-1';
        const runner = vi
            .fn()
            .mockResolvedValueOnce(runListJson())
            .mockResolvedValueOnce(ingest)
            .mockResolvedValueOnce(afterIngest);

        await expect(
            publishAcceptanceRound(
                state,
                { headSha: 'head-1', reportDirectory: directory },
                runner,
            ),
        ).rejects.toThrow(expected);
        expect(state.acceptance.publication.history).toEqual([]);
        expect(state.acceptance.round).toBe(0);
    });

    it('keeps network interruption unpublished and preserves orphaned standalone history', async () => {
        const state = publicationState('publish-audit');
        const directory = await writeRound(1, 'head-1');
        const runner = vi
            .fn()
            .mockResolvedValueOnce(runListJson())
            .mockRejectedValueOnce(new Error('network interrupted'))
            .mockResolvedValueOnce(runListJson());
        await expect(
            publishAcceptanceRound(
                state,
                { headSha: 'head-1', reportDirectory: directory },
                runner,
            ),
        ).rejects.toThrow('network interrupted');
        expect(state.acceptance.publication.history).toEqual([]);

        recordOrphanedAcceptance(state, {
            acceptanceId: 'acc-orphan',
            reason: '第二轮曾误建为 standalone，保留不可变审计历史。',
            verifyRunId: 'run-orphan',
        });
        recordOrphanedAcceptance(state, {
            acceptanceId: 'acc-orphan',
            reason: '第二轮曾误建为 standalone，保留不可变审计历史。',
            verifyRunId: 'run-orphan',
        });
        expect(state.acceptance.publication.orphanedStandalones).toEqual([
            expect.objectContaining({
                acceptanceId: 'acc-orphan',
                verifyRunId: 'run-orphan',
            }),
        ]);
    });

    it('clears an explicitly orphaned matching pending publication', () => {
        const state = publicationState('orphan-pending');
        state.acceptance.publication.pendingAttempt = {
            acceptanceId: 'acc-partial',
            checkIds: ['acceptance-round-lineage'],
            createdAt: '2026-08-12T01:00:00.000Z',
            headSha: 'head-1',
            reportPath: '.records/go/orphan-pending/acceptance/round-1',
            roundIndex: 1,
            verdict: 'pass',
            verifyRunId: 'run-partial',
        };

        recordOrphanedAcceptance(state, {
            acceptanceId: 'acc-partial',
            reason: '大证据上传超时，保留部分提交历史并重新发布完整轮次。',
            verifyRunId: 'run-partial',
        });

        expect(state.acceptance.publication.pendingAttempt).toBeNull();
        expect(state.acceptance.publication.orphanedStandalones).toHaveLength(1);
    });

    it('restarts an inaccessible frozen lineage without deleting its publication history', async () => {
        const state = publicationState('restart-lineage');
        recordPublishedAcceptance(state, {
            acceptanceId: 'acc-old',
            checkIds: ['acceptance-round-lineage'],
            headSha: 'head-old',
            publishedAt: '2026-08-11T00:00:00.000Z',
            roundIndex: 1,
            url: 'https://app.lobehub.com/acceptance/acc-old',
            verdict: 'pass',
            verifyRunId: 'run-old',
        });
        state.handoffReport = {
            deliveredAt: '2026-08-11T01:00:00.000Z',
            evidence: {
                actionsUse: 'pinned',
                commitFileMetrics: 'recorded',
                costCheckpointCount: 1,
                issueDriftAssessmentCount: 1,
                issueDriftCommentCount: 0,
                reviewBaselineId: 'review-001',
                reviewDecisionCount: 1,
                reviewLineageComplete: true,
                reviewPolicyMode: 'light',
                validationRepairCount: 0,
            },
            generatedAt: '2026-08-11T00:30:00.000Z',
            headSha: 'head-1',
            path: 'handoff-report.md',
            sections: [
                'delivery',
                'review',
                'technical-debt',
                'workflow',
                'cost',
                'automation',
                'boundaries',
            ],
            sha256: 'a'.repeat(64),
        };

        state.phase = 'delivery';
        expect(() =>
            restartAcceptanceLineage(state, {
                acceptanceId: 'acc-old',
                reason: '当前认证主体无法追加旧 Acceptance。',
            }),
        ).toThrow('Acceptance phase');
        state.phase = 'acceptance';

        expect(() =>
            restartAcceptanceLineage(state, {
                acceptanceId: 'acc-other',
                reason: '当前认证主体无法追加旧 Acceptance。',
            }),
        ).toThrow('active frozen Acceptance');

        restartAcceptanceLineage(state, {
            acceptanceId: 'acc-old',
            reason: '当前认证主体无法追加旧 Acceptance。',
        });

        expect(state.acceptance).toMatchObject({
            id: null,
            round: 0,
            status: 'not_started',
            url: null,
        });
        expect(state.acceptance.publication.history).toEqual([
            expect.objectContaining({ acceptanceId: 'acc-old', verifyRunId: 'run-old' }),
        ]);
        expect(state.acceptance.publication.orphanedStandalones).toEqual([
            expect.objectContaining({ acceptanceId: 'acc-old', verifyRunId: 'run-old' }),
        ]);
        expect(state.handoffReport).toBeNull();

        const directory = await writeRound(1, 'head-1');
        const runner = vi
            .fn()
            .mockResolvedValueOnce(runListJson())
            .mockResolvedValueOnce(ingestJson(1, 'acc-new', 'run-new'))
            .mockResolvedValueOnce(viewJson({ acceptanceId: 'acc-new', verifyRunId: 'run-new' }));

        await expect(
            publishAcceptanceRound(
                state,
                { headSha: 'head-1', reportDirectory: directory },
                runner,
            ),
        ).resolves.toMatchObject({ acceptanceId: 'acc-new', roundIndex: 1 });
        expect(state.acceptance.publication.history).toEqual([
            expect.objectContaining({ acceptanceId: 'acc-old' }),
            expect.objectContaining({ acceptanceId: 'acc-new' }),
        ]);
    });

    it('persists an unresolved ingest and retries only its remote readback', async () => {
        const state = publicationState('readback-recovery');
        const directory = await writeRound(1, 'head-1');
        const persistPending = vi.fn(() => Promise.resolve());
        const interrupted = vi
            .fn()
            .mockResolvedValueOnce(runListJson())
            .mockResolvedValueOnce(ingestJson(1))
            .mockRejectedValueOnce(new Error('view network interrupted'));

        await expect(
            publishAcceptanceRound(
                state,
                { headSha: 'head-1', reportDirectory: directory },
                interrupted,
                '2026-08-12T01:00:00.000Z',
                persistPending,
            ),
        ).rejects.toThrow('view network interrupted');
        expect(persistPending).toHaveBeenCalledOnce();
        expect(state.acceptance.publication.pendingAttempt).toMatchObject({
            acceptanceId: 'acc-1',
            roundIndex: 1,
            verifyRunId: 'run-1',
        });
        expect(createResumeCheckpoint(state)).toMatchObject({
            blockers: ['Acceptance publication is waiting for exact remote readback'],
            nextAction: 'Retry readback for the pending Acceptance publication',
        });

        const retry = vi.fn().mockResolvedValueOnce(viewJson());
        await expect(
            publishAcceptanceRound(state, { headSha: 'head-1', reportDirectory: directory }, retry),
        ).resolves.toMatchObject({ verifyRunId: 'run-1' });
        expect(retry).toHaveBeenCalledWith('lh', ['acceptance', 'view', 'acc-1', '--json']);
        expect(state.acceptance.publication.pendingAttempt).toBeNull();
        expect(state.acceptance.publication.history).toHaveLength(1);
    });

    it('recovers remote success with missing ingest stdout and never creates another round', async () => {
        const state = publicationState('missing-stdout');
        const directory = await writeRound(1, 'head-1');
        const runner = vi
            .fn()
            .mockResolvedValueOnce(runListJson())
            .mockResolvedValueOnce('')
            .mockResolvedValueOnce(runListJson({ roundIndex: 1 }))
            .mockResolvedValueOnce(viewJson());

        await expect(
            publishAcceptanceRound(
                state,
                { headSha: 'head-1', reportDirectory: directory },
                runner,
            ),
        ).resolves.toMatchObject({ acceptanceId: 'acc-1', verifyRunId: 'run-1' });
        expect(
            runner.mock.calls.filter(([, arguments_]) =>
                (arguments_ as string[]).includes('ingest'),
            ),
        ).toHaveLength(1);
        expect(state.acceptance.publication.history).toHaveLength(1);
    });

    it('discovers a prior response-lost round before retrying ingest', async () => {
        const state = publicationState('response-lost-retry');
        const directory = await writeRound(1, 'head-1');
        const runner = vi
            .fn()
            .mockResolvedValueOnce(runListJson({ roundIndex: 1 }))
            .mockResolvedValueOnce(viewJson());

        await publishAcceptanceRound(
            state,
            { headSha: 'head-1', reportDirectory: directory },
            runner,
        );
        expect(
            runner.mock.calls.filter(([, arguments_]) =>
                (arguments_ as string[]).includes('ingest'),
            ),
        ).toHaveLength(0);
        expect(state.acceptance.publication.history).toHaveLength(1);
    });

    it('ignores unrelated legacy and incomplete runs during exact round discovery', async () => {
        const state = publicationState('legacy-run-history');
        const directory = await writeRound(1, 'head-1');
        const exactRun = {
            acceptanceId: 'acc-1',
            context: { commit: 'head-1', testedAt: '2026-08-12T00:00:00.000Z' },
            id: 'run-1',
            plan: [{ id: 'acceptance-round-lineage' }],
            roundIndex: 1,
            source: 'agent-testing',
        };
        const runner = vi
            .fn()
            .mockResolvedValueOnce(
                JSON.stringify([
                    {
                        acceptanceId: 'legacy-acceptance',
                        context: null,
                        id: 'legacy-run',
                        plan: [],
                        roundIndex: 1,
                        source: 'agent',
                    },
                    {
                        acceptanceId: null,
                        context: { commit: 'other-head', testedAt: '2026-08-11T00:00:00.000Z' },
                        id: 'incomplete-run',
                        plan: [],
                        roundIndex: null,
                        source: 'agent-testing',
                    },
                    exactRun,
                ]),
            )
            .mockResolvedValueOnce(viewJson());

        await expect(
            publishAcceptanceRound(
                state,
                { headSha: 'head-1', reportDirectory: directory },
                runner,
            ),
        ).resolves.toMatchObject({ acceptanceId: 'acc-1', verifyRunId: 'run-1' });
        expect(
            runner.mock.calls.filter(([, arguments_]) =>
                (arguments_ as string[]).includes('ingest'),
            ),
        ).toHaveLength(0);
    });
});
