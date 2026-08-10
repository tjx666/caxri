import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
    admitCiFallback,
    PLATFORM_NEUTRAL_CI_COMMANDS,
    recordCiFallbackResult,
} from './ci-fallback';
import { createResumeCheckpoint } from './resume';
import { createInitialState, recordPullRequest, transitionState, validateState } from './state';

const headSha = 'abc123';
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

function blockedDelivery() {
    const state = createInitialState({
        objective: 'Verify local fallback',
        runId: 'fallback-test',
    });
    transitionState(state, 'planning');
    transitionState(state, 'issue_execution');
    transitionState(state, 'deep_review');
    transitionState(state, 'delivery');
    recordPullRequest(state, {
        headSha,
        number: 53,
        status: 'checks_blocked',
        url: 'https://github.com/tjx666/caxri/pull/53',
    });
    return state;
}

function admit(state: ReturnType<typeof blockedDelivery>) {
    return admitCiFallback(
        state,
        {
            authorization: 'The user explicitly authorized local CI fallback for this head.',
            failureDetail: 'The job was rejected before runner allocation.',
            failureJob: 'checks',
            failureKind: 'billing',
            failureRunUrl: 'https://github.com/tjx666/caxri/actions/runs/123',
            headSha,
            verifiedZeroSteps: true,
        },
        '2026-08-10T00:00:00.000Z',
    );
}

describe('Go local CI fallback', () => {
    it('matches every executable step in the hosted checks job', async () => {
        const workflow = await readFile(resolve(projectRoot, '.github/workflows/ci.yml'), 'utf8');
        const checksJob = workflow.match(/\n {2}checks:\n([\s\S]*?)\n {2}e2e:/)?.[1] ?? '';
        const nonSetupActions = [...checksJob.matchAll(/^\s+- uses: (.+)$/gm)]
            .map((match) => match[1])
            .filter(
                (action) =>
                    !/^(actions\/checkout|actions\/setup-node|oven-sh\/setup-bun)@/.test(action),
            );
        const commands = [...checksJob.matchAll(/^\s+- run: (.+)$/gm)]
            .map((match) => match[1])
            .filter((command) => command !== 'npm ci');

        expect(nonSetupActions).toEqual([]);
        expect(commands).toEqual(PLATFORM_NEUTRAL_CI_COMMANDS);
    });

    it('rejects fallback without every admission boundary', () => {
        const state = blockedDelivery();

        expect(() => transitionState(state, 'acceptance')).toThrow(
            'green hosted checks or a passed exact-head local CI fallback',
        );
        expect(() =>
            admitCiFallback(state, {
                authorization: '',
                failureDetail: 'Runner allocation failed.',
                failureJob: 'checks',
                failureKind: 'infrastructure',
                failureRunUrl: 'https://github.com/tjx666/caxri/actions/runs/123',
                headSha,
                verifiedZeroSteps: true,
            }),
        ).toThrow('explicit user authorization');
        expect(() =>
            admitCiFallback(state, {
                authorization: 'User approved.',
                failureDetail: 'Runner allocation failed.',
                failureJob: 'checks',
                failureKind: 'infrastructure',
                failureRunUrl: 'https://github.com/tjx666/caxri/actions/runs/123',
                headSha,
                verifiedZeroSteps: false,
            }),
        ).toThrow('verified zero-step');
        expect(() =>
            admitCiFallback(state, {
                authorization: 'User approved.',
                failureDetail: 'Runner allocation failed.',
                failureJob: 'checks',
                failureKind: 'infrastructure',
                failureRunUrl: 'https://github.com/tjx666/caxri/actions/runs/123',
                headSha: 'different-head',
                verifiedZeroSteps: true,
            }),
        ).toThrow('exact current PR head');
    });

    it('records exact-head evidence and keeps hosted checks externally blocked', () => {
        const state = blockedDelivery();
        admit(state);

        expect(state.ciFallback).toMatchObject({
            externalFailure: { kind: 'billing', zeroSteps: true },
            headSha,
            status: 'admitted',
        });
        expect(() =>
            recordCiFallbackResult(state, {
                electronE2eCommand: 'bun run test:e2e',
                electronE2eResult: 'passed',
                headSha: 'different-head',
                platformCommands: [...PLATFORM_NEUTRAL_CI_COMMANDS],
                platformResult: 'passed',
            }),
        ).toThrow('exact admitted PR head');

        recordCiFallbackResult(
            state,
            {
                electronE2eCommand: 'bun run test:e2e',
                electronE2eResult: 'passed',
                headSha,
                platformCommands: [...PLATFORM_NEUTRAL_CI_COMMANDS],
                platformResult: 'passed',
            },
            '2026-08-10T00:30:00.000Z',
        );

        expect(state.ciFallback).toMatchObject({
            electronE2e: { commands: ['bun run test:e2e'], result: 'passed' },
            platformNeutral: { result: 'passed' },
            status: 'passed',
        });
        expect(state.pullRequest.status).toBe('checks_blocked');
        expect(validateState(state)).toEqual(state);
        expect(() => transitionState(state, 'acceptance')).not.toThrow();
    });

    it('invalidates recorded fallback evidence when the PR head changes', () => {
        const state = blockedDelivery();
        admit(state);

        recordPullRequest(state, { headSha: 'new-head', status: 'checks_pending' });

        expect(state.ciFallback.status).toBe('not_requested');
        expect(state.events.at(-2)).toMatchObject({
            detail: `Invalidated admitted fallback for ${headSha}`,
            type: 'ci_fallback',
        });
        expect(validateState(state)).toEqual(state);
    });

    it('rejects partial parity commands and non-full Electron runs', () => {
        const partialState = blockedDelivery();
        admit(partialState);
        expect(() =>
            recordCiFallbackResult(partialState, {
                electronE2eCommand: 'bun run test:e2e',
                electronE2eResult: 'passed',
                headSha,
                platformCommands: ['bun run lint'],
                platformResult: 'passed',
            }),
        ).toThrow('exact platform-neutral CI gates');

        const focusedState = blockedDelivery();
        admit(focusedState);
        expect(() =>
            recordCiFallbackResult(focusedState, {
                electronE2eCommand: 'bunx playwright test e2e/project.spec.ts',
                electronE2eResult: 'passed',
                headSha,
                platformCommands: [...PLATFORM_NEUTRAL_CI_COMMANDS],
                platformResult: 'passed',
            }),
        ).toThrow('one full isolated Electron E2E suite');
    });

    it('does not advance when either local parity surface fails', () => {
        const state = blockedDelivery();
        admit(state);
        recordCiFallbackResult(state, {
            electronE2eCommand: 'bun run test:e2e',
            electronE2eResult: 'failed',
            headSha,
            platformCommands: [...PLATFORM_NEUTRAL_CI_COMMANDS],
            platformResult: 'passed',
        });

        expect(state.ciFallback.status).toBe('failed');
        expect(() => admit(state)).toThrow('new PR head');
        expect(createResumeCheckpoint(state).nextAction).toBe(
            'Repair the failure, push a new head, and wait for new hosted checks',
        );
        expect(() => transitionState(state, 'acceptance')).toThrow(
            'green hosted checks or a passed exact-head local CI fallback',
        );
    });

    it('does not report hosted CI as a blocker after exact-head fallback passes', () => {
        const state = blockedDelivery();
        admit(state);
        recordCiFallbackResult(state, {
            electronE2eCommand: 'bun run test:e2e',
            electronE2eResult: 'passed',
            headSha,
            platformCommands: [...PLATFORM_NEUTRAL_CI_COMMANDS],
            platformResult: 'passed',
        });

        expect(createResumeCheckpoint(state)).toMatchObject({
            blockers: [],
            ciFallback: { status: 'passed' },
            pullRequest: { status: 'checks_blocked' },
        });
    });
});
