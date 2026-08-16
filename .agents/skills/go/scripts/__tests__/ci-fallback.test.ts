import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
    admitCiFallback,
    PLATFORM_NEUTRAL_CI_COMMANDS,
    recordCiFallbackResult,
} from '../ci-fallback';
import { createResumeCheckpoint } from '../resume';
import { recordReviewDecision } from '../review-gate';
import {
    createInitialState,
    recordPullRequest,
    transitionState,
    validateState,
} from '../state-model';

const headSha = 'abc123';
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const fullChecksCondition = "needs.retry-policy.outputs.checks_scope == 'full'";

interface ActionsWorkflow {
    jobs?: {
        checks?: {
            steps?: Array<{ if?: string; run?: string; uses?: string }>;
        };
    };
}

function blockedDelivery() {
    const state = createInitialState({
        objective: 'Verify local fallback',
        runId: 'fallback-test',
    });
    transitionState(state, 'planning');
    transitionState(state, 'issue_execution');
    transitionState(state, 'deep_review');
    for (const [index, command] of PLATFORM_NEUTRAL_CI_COMMANDS.entries()) {
        state.validations.push({
            attempt: 1,
            command,
            completedAt: '2026-08-10T00:00:00.000Z',
            exitCode: 0,
            headSha,
            id: `gate-${index}`,
            integrityError: null,
            kind: 'gates',
            lineageId: `gate-${index}`,
            logPath: `validation/gate-${index}.log`,
            result: 'passed',
            sessionId: `gate-${index}`,
            sourceFingerprint: 'fixture-fingerprint',
            startedAt: '2026-08-10T00:00:00.000Z',
        });
    }
    recordReviewDecision(state, {
        freeze: true,
        headSha,
        mode: 'full',
        p0: 0,
        p1: 0,
        reviewedRange: 'origin/main...abc123',
        scope: 'Goal range',
    });
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
            authorization: 'User approved this exact-head Actions fallback.',
            failureDetail: 'The job was not started because the spending limit was reached.',
            failureJob: 'checks',
            failureKind: 'billing',
            failureRunUrl: 'https://github.com/tjx666/caxri/actions/runs/123',
            headSha,
            verifiedZeroSteps: true,
        },
        '2026-08-10T00:00:00.000Z',
    );
}

function reviewDeliveryDelta(
    state: ReturnType<typeof blockedDelivery>,
    parentHeadSha: string,
    nextHeadSha: string,
) {
    const parent = state.reviewGate.rounds.at(-1)!;
    return recordReviewDecision(state, {
        baselineHeadSha: 'abc123',
        baselineReviewId: 'review-001',
        freeze: true,
        headSha: nextHeadSha,
        mode: 'light',
        p0: 0,
        p1: 0,
        parentReviewId: parent.id,
        reviewedRange: `${parentHeadSha}..${nextHeadSha}`,
        scope: 'Delivery repair delta',
    });
}

describe('Go local CI fallback', () => {
    it('matches every executable step in the self-hosted checks job', async () => {
        const workflow = await readFile(resolve(projectRoot, '.github/workflows/ci.yml'), 'utf8');
        const steps = parse(workflow) as ActionsWorkflow;
        const checkSteps = steps.jobs?.checks?.steps ?? [];
        const nonSetupActions = checkSteps
            .flatMap((step) => (step.uses ? [step.uses] : []))
            .filter(
                (action) =>
                    !/^(?:actions\/(?:cache|checkout|setup-node)|oven-sh\/setup-bun|pnpm\/setup)@/.test(
                        action,
                    ) && action !== './.github/actions/setup-caxri-job',
            );
        const commands = checkSteps
            .filter((step) => step.if === fullChecksCondition && step.run)
            .map((step) =>
                step.run!.includes('-- bun run lint --concurrency') ? 'bun run lint' : step.run!,
            );

        expect(nonSetupActions).toEqual([]);
        expect(commands).toEqual(PLATFORM_NEUTRAL_CI_COMMANDS);
        expect(commands).toContain('bun run doctor:changed');
        expect(workflow).toContain(
            "CAXRI_REACT_DOCTOR_BASE: ${{ github.event_name == 'pull_request' && github.event.pull_request.base.sha || github.event.before }}",
        );
    });

    it('rejects fallback without every admission boundary', () => {
        const state = blockedDelivery();

        expect(() => transitionState(state, 'acceptance')).toThrow(
            'green Actions checks or a passed exact-head local CI fallback',
        );
        expect(createResumeCheckpoint(state).nextAction).toBe(
            'Classify the zero-step failure and request explicit fallback authorization',
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
        ).toThrow('Local CI fallback requires explicit user authorization');
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

    it('rejects fallback after the reviewed head is invalidated', () => {
        const state = blockedDelivery();
        state.reviewGate.frozenHeadSha = null;

        expect(() => admit(state)).toThrow('explicitly frozen review-clean head');
    });

    it('records exact-head evidence and keeps Actions checks externally blocked', () => {
        const state = blockedDelivery();
        admit(state);

        expect(state.ciFallback).toMatchObject({
            externalFailure: { kind: 'billing', zeroSteps: true },
            headSha,
            status: 'admitted',
        });
        expect(state.ciFallback.authorization?.detail).toBe(
            'User approved this exact-head Actions fallback.',
        );
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

    it('preserves explicit infrastructure authorization in the ledger', () => {
        const state = blockedDelivery();

        admitCiFallback(state, {
            authorization: 'User approved this exact-head infrastructure fallback.',
            failureDetail: 'Runner allocation failed before any step started.',
            failureJob: 'checks',
            failureKind: 'infrastructure',
            failureRunUrl: 'https://github.com/tjx666/caxri/actions/runs/123',
            headSha,
            verifiedZeroSteps: true,
        });

        expect(state.ciFallback.authorization?.detail).toBe(
            'User approved this exact-head infrastructure fallback.',
        );
    });

    it('requires explicit user authorization for billing failures', () => {
        const state = blockedDelivery();

        expect(() =>
            admitCiFallback(state, {
                failureDetail: 'The Actions job did not start.',
                failureJob: 'checks',
                failureKind: 'billing',
                failureRunUrl: 'https://github.com/tjx666/caxri/actions/runs/123',
                headSha,
                verifiedZeroSteps: true,
            }),
        ).toThrow('requires explicit user authorization');
    });

    it('invalidates recorded fallback evidence when the PR head changes', () => {
        const state = blockedDelivery();
        admit(state);

        recordPullRequest(state, { headSha: 'new-head', status: 'checks_pending' });

        expect(state.ciFallback.status).toBe('not_requested');
        expect(state.reviewGate.frozenHeadSha).toBeNull();
        expect(state.events.findLast(({ type }) => type === 'ci_fallback')).toMatchObject({
            detail: `Invalidated fallback for ${headSha}`,
            type: 'ci_fallback',
        });
        expect(validateState(state)).toEqual(state);
    });

    it('preserves a replacement head freeze recorded before the PR update', () => {
        const state = blockedDelivery();
        reviewDeliveryDelta(state, headSha, 'reviewed-replacement');

        recordPullRequest(state, { headSha: 'reviewed-replacement', status: 'checks_pending' });

        expect(state.reviewGate.frozenHeadSha).toBe('reviewed-replacement');
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
            'Repair the failure, push a new head, and wait for new Actions checks',
        );
        expect(() => transitionState(state, 'acceptance')).toThrow(
            'green Actions checks or a passed exact-head local CI fallback',
        );
    });

    it('does not report Actions CI as a blocker after exact-head fallback passes', () => {
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

    it('limits a Go run to two full Electron E2E attempts', () => {
        const state = blockedDelivery();
        admit(state);
        recordCiFallbackResult(state, {
            electronE2eCommand: 'bun run test:e2e',
            electronE2eResult: 'failed',
            headSha,
            platformCommands: [...PLATFORM_NEUTRAL_CI_COMMANDS],
            platformResult: 'passed',
        });

        recordPullRequest(state, { headSha: 'second-head', status: 'checks_blocked' });
        reviewDeliveryDelta(state, headSha, 'second-head');
        admitCiFallback(state, {
            authorization: 'User approved the second exact-head Actions fallback.',
            failureDetail: 'The job was not started because the spending limit was reached.',
            failureJob: 'checks',
            failureKind: 'billing',
            failureRunUrl: 'https://github.com/tjx666/caxri/actions/runs/124',
            headSha: 'second-head',
            verifiedZeroSteps: true,
        });
        recordCiFallbackResult(state, {
            electronE2eCommand: 'bun run test:e2e',
            electronE2eResult: 'failed',
            headSha: 'second-head',
            platformCommands: [...PLATFORM_NEUTRAL_CI_COMMANDS],
            platformResult: 'passed',
        });

        recordPullRequest(state, { headSha: 'third-head', status: 'checks_blocked' });
        reviewDeliveryDelta(state, 'second-head', 'third-head');
        expect(() =>
            admitCiFallback(state, {
                authorization: 'User approved the third exact-head Actions fallback.',
                failureDetail: 'The job was not started because the spending limit was reached.',
                failureJob: 'checks',
                failureKind: 'billing',
                failureRunUrl: 'https://github.com/tjx666/caxri/actions/runs/125',
                headSha: 'third-head',
                verifiedZeroSteps: true,
            }),
        ).toThrow('at most two full Electron E2E suites');
    });

    it('does not repeat a passing full E2E without human rejection', () => {
        const state = blockedDelivery();
        admit(state);
        recordCiFallbackResult(state, {
            electronE2eCommand: 'bun run test:e2e',
            electronE2eResult: 'passed',
            headSha,
            platformCommands: [...PLATFORM_NEUTRAL_CI_COMMANDS],
            platformResult: 'passed',
        });

        recordPullRequest(state, { headSha: 'replacement-head', status: 'checks_blocked' });
        reviewDeliveryDelta(state, headSha, 'replacement-head');
        const input = {
            authorization: 'User approved the replacement-head Actions fallback.',
            failureDetail: 'The job was not started because the spending limit was reached.',
            failureJob: 'checks',
            failureKind: 'billing' as const,
            failureRunUrl: 'https://github.com/tjx666/caxri/actions/runs/126',
            headSha: 'replacement-head',
            verifiedZeroSteps: true,
        };

        expect(() => admitCiFallback(state, input)).toThrow(
            'cannot be repeated unless human Acceptance rejected',
        );
        state.acceptance.status = 'rejected';
        expect(() => admitCiFallback(state, input)).not.toThrow();
    });
});
