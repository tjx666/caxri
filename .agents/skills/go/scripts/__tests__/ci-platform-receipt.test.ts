import { describe, expect, it } from 'vitest';

import type { CiPlatformReceiptApi } from '../ci-platform-receipt';
import { readCiPlatformReceipt } from '../ci-platform-receipt';
import { PLATFORM_NEUTRAL_CI_COMMANDS } from '../platform-neutral-gates';

const headSha = 'a'.repeat(40);

function successfulApi(
    overrides: {
        job?: Record<string, unknown>;
        run?: Record<string, unknown>;
    } = {},
): CiPlatformReceiptApi {
    return {
        listJobs() {
            return Promise.resolve([
                {
                    conclusion: 'success',
                    head_sha: headSha,
                    name: 'checks',
                    steps: [
                        {
                            conclusion: 'success',
                            name: 'Run full platform checks',
                            status: 'completed',
                        },
                    ],
                    ...overrides.job,
                },
            ] as Awaited<ReturnType<CiPlatformReceiptApi['listJobs']>>);
        },
        listRuns() {
            return Promise.resolve([
                {
                    conclusion: 'success',
                    event: 'workflow_dispatch',
                    head_sha: headSha,
                    html_url: 'https://github.com/tjx666/caxri/actions/runs/42',
                    id: 42,
                    status: 'completed',
                    ...overrides.run,
                },
            ] as Awaited<ReturnType<CiPlatformReceiptApi['listRuns']>>);
        },
    };
}

describe('Go exact-head CI platform receipt', () => {
    it('accepts a successful full platform check on the requested head', async () => {
        await expect(readCiPlatformReceipt(headSha, successfulApi())).resolves.toEqual({
            commands: PLATFORM_NEUTRAL_CI_COMMANDS,
            headSha,
            runId: 42,
            runUrl: 'https://github.com/tjx666/caxri/actions/runs/42',
        });
    });

    it.each(['failure', 'cancelled', null])(
        'rejects a run with conclusion %s',
        async (conclusion) => {
            await expect(
                readCiPlatformReceipt(headSha, successfulApi({ run: { conclusion } })),
            ).resolves.toBeNull();
        },
    );

    it('rejects a branch run for another commit and an in-progress run', async () => {
        const otherHead = 'b'.repeat(40);
        await expect(
            readCiPlatformReceipt(headSha, successfulApi({ run: { head_sha: otherHead } })),
        ).resolves.toBeNull();
        await expect(
            readCiPlatformReceipt(headSha, successfulApi({ run: { status: 'in_progress' } })),
        ).resolves.toBeNull();
    });

    it('rejects skipped, failed, and synthetic-merge platform checks', async () => {
        const jobs = [
            { conclusion: 'skipped' },
            { head_sha: 'b'.repeat(40) },
            {
                steps: [
                    {
                        conclusion: 'skipped',
                        name: 'Run full platform checks',
                        status: 'completed',
                    },
                ],
            },
        ];
        const receipts = await Promise.all(
            jobs.map((job) => readCiPlatformReceipt(headSha, successfulApi({ job }))),
        );
        expect(receipts).toEqual([null, null, null]);
        await expect(
            readCiPlatformReceipt(headSha, successfulApi({ run: { event: 'pull_request' } })),
        ).resolves.toBeNull();
    });
});
