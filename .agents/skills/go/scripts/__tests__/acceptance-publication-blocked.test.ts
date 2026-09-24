import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { afterEach, expect, it, vi } from 'vitest';

import { publishAcceptanceRound } from '../acceptance-publication';
import { createInitialState } from '../state-model';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const TEST_ROOT = join(PROJECT_ROOT, '.records', '__test__', `acceptance-blocked-${process.pid}`);
const CHECK_ID = 'desktop-recovery';

afterEach(async () => {
    await rm(TEST_ROOT, { force: true, recursive: true });
});

it.each(['blocked', 'pass'] as const)('checks planned media against a %s case', async (status) => {
    const directory = join(TEST_ROOT, 'round-1');
    await mkdir(join(directory, 'assets'), { recursive: true });
    await writeFile(join(directory, 'assets', 'setup-blocker.txt'), 'Planned UI unavailable');
    await writeFile(
        join(directory, 'result.json'),
        JSON.stringify({
            cases: [
                {
                    evidence: ['assets/setup-blocker.txt'],
                    id: CHECK_ID,
                    status,
                    surface: 'desktop',
                },
            ],
            commit: 'head-1',
            createdAt: '2026-08-12T00:00:00.000Z',
            plan: [
                {
                    id: CHECK_ID,
                    requiredEvidence: ['video', 'screenshot', 'dom_snapshot'],
                    surface: 'desktop',
                },
            ],
            requirement: 'Publish the observed desktop result.',
            summary: { verdict: status === 'blocked' ? 'partial' : 'pass' },
        }),
    );

    const state = createInitialState({ objective: 'Publish Acceptance', runId: status });
    state.phase = 'acceptance';
    state.status = 'active';
    state.pullRequest.headSha = 'head-1';
    const runner = vi
        .fn()
        .mockResolvedValueOnce('[]')
        .mockResolvedValueOnce(
            JSON.stringify({ acceptanceId: 'acc-1', roundIndex: 1, verifyRunId: 'run-1' }),
        )
        .mockResolvedValueOnce(
            JSON.stringify({
                acceptance: { id: 'acc-1' },
                checks: [
                    {
                        evidence: [{ content: 'Planned UI unavailable', type: 'text' }],
                        id: 'server-check-id',
                        planItem: { id: CHECK_ID, verifierConfig: { surface: 'desktop' } },
                        resultRound: 1,
                        surface: 'desktop',
                    },
                ],
                rounds: [
                    {
                        report: { verdict: status === 'blocked' ? 'uncertain' : 'passed' },
                        run: {
                            acceptanceId: 'acc-1',
                            context: { commit: 'head-1' },
                            id: 'run-1',
                            roundIndex: 1,
                        },
                    },
                ],
            }),
        );
    const publication = publishAcceptanceRound(
        state,
        { headSha: 'head-1', reportDirectory: directory },
        runner,
    );

    if (status === 'blocked') {
        await expect(publication).resolves.toMatchObject({ verdict: 'partial' });
    } else {
        await expect(publication).rejects.toThrow('required video evidence');
    }
});
