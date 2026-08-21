import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface TrustPolicy {
    trustedActor: string;
    ci: {
        pullRequestEvent: string;
        workflowDispatchEvent: string;
        pushEvent: string;
        pushRef: string;
    };
    release: {
        conclusion: string;
        event: string;
        branch: string;
        titlePrefix: string;
    };
}

interface WorkflowStep {
    env?: Record<string, string>;
    uses?: string;
    with?: Record<string, string>;
}

interface WorkflowJob {
    if?: string;
    steps?: WorkflowStep[];
}

interface WorkflowDocument {
    jobs: Record<string, WorkflowJob>;
}

const policy = JSON.parse(
    await readFile(new URL('../../.github/ci-trust-policy.json', import.meta.url), 'utf8'),
) as TrustPolicy;
const ciWorkflow = parse(
    await readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
) as WorkflowDocument;
const releaseWorkflow = parse(
    await readFile(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8'),
) as WorkflowDocument;
const verifierAction = await readFile(
    new URL('../../.github/actions/verify-trust-boundary/action.yml', import.meta.url),
    'utf8',
);
const verifierActionDocument = parse(verifierAction) as {
    runs: { steps: Array<{ env: Record<string, string>; run: string }> };
};

const ciVerifierInputs = {
    'actor': '${{ github.actor }}',
    'event-name': '${{ github.event_name }}',
    'event-ref': '${{ github.ref }}',
    'event-repository': '${{ github.event.pull_request.head.repo.full_name || github.repository }}',
    'pull-request-author': '${{ github.event.pull_request.user.login || github.actor }}',
    'triggering-actor': '${{ github.triggering_actor }}',
};
const releaseVerifierInputs = {
    'actor': '${{ github.event.workflow_run.actor.login }}',
    'event-name': '${{ github.event.workflow_run.event }}',
    'event-ref': 'refs/heads/${{ github.event.workflow_run.head_branch }}',
    'event-repository': '${{ github.event.workflow_run.head_repository.full_name }}',
    'pull-request-author': '${{ github.event.workflow_run.actor.login }}',
    'triggering-actor': '${{ github.event.workflow_run.triggering_actor.login }}',
};

function normalizeExpression(expression: string): string {
    return expression
        .replace(/^\$\{\{\s*/u, '')
        .replace(/\s*\}\}$/u, '')
        .replaceAll(/\s+/gu, '');
}

function normalizeMapping(mapping: Record<string, string> | undefined): string {
    return JSON.stringify(
        Object.entries(mapping ?? {}).toSorted(([left], [right]) => left.localeCompare(right)),
    );
}

function expressionMismatch(
    location: string,
    actual: string | undefined,
    expected: string,
): string | undefined {
    return normalizeExpression(actual ?? '') === normalizeExpression(expected)
        ? undefined
        : location;
}

function ciTrustExpression(candidatePolicy: TrustPolicy = policy): string {
    const actor = `'${candidatePolicy.trustedActor}'`;

    return `
        (
          github.event_name == '${candidatePolicy.ci.pullRequestEvent}' &&
          github.actor == ${actor} &&
          github.triggering_actor == ${actor} &&
          github.event.pull_request.user.login == ${actor} &&
          github.event.pull_request.head.repo.full_name == github.repository
        ) || (
          github.event_name == '${candidatePolicy.ci.workflowDispatchEvent}' &&
          github.actor == ${actor} &&
          github.triggering_actor == ${actor}
        ) || (
          github.event_name == '${candidatePolicy.ci.pushEvent}' &&
          github.ref == '${candidatePolicy.ci.pushRef}' &&
          github.actor == ${actor} &&
          github.triggering_actor == ${actor}
        )
    `;
}

function releaseTrustExpression(candidatePolicy: TrustPolicy = policy): string {
    const actor = `'${candidatePolicy.trustedActor}'`;

    return `
        github.event.workflow_run.conclusion == '${candidatePolicy.release.conclusion}' &&
        github.event.workflow_run.event == '${candidatePolicy.release.event}' &&
        github.event.workflow_run.head_branch == '${candidatePolicy.release.branch}' &&
        github.event.workflow_run.head_repository.full_name == github.repository &&
        github.event.workflow_run.actor.login == ${actor} &&
        github.event.workflow_run.triggering_actor.login == ${actor} &&
        startsWith(github.event.workflow_run.display_title, '${candidatePolicy.release.titlePrefix}')
    `;
}

function trustExpressionMismatches(candidatePolicy: TrustPolicy = policy): string[] {
    const gateTrustExpression = ciWorkflow.jobs.ci.steps?.find((step) => step.env?.TRUSTED_EVENT)
        ?.env?.TRUSTED_EVENT;
    const cases = [
        {
            actual: ciWorkflow.jobs['retry-policy'].if,
            expected: ciTrustExpression(candidatePolicy),
            location: 'ci.jobs.retry-policy.if',
        },
        {
            actual: gateTrustExpression,
            expected: ciTrustExpression(candidatePolicy),
            location: 'ci.jobs.ci.env.TRUSTED_EVENT',
        },
        {
            actual: releaseWorkflow.jobs.release.if,
            expected: releaseTrustExpression(candidatePolicy),
            location: 'release.jobs.release.if',
        },
    ];

    return cases.flatMap(
        ({ actual, expected, location }) => expressionMismatch(location, actual, expected) ?? [],
    );
}

function verifierInputMismatches(): string[] {
    const cases = [
        ...['retry-policy', 'checks', 'e2e'].map((jobName) => ({
            actual: ciWorkflow.jobs[jobName].steps?.find(
                (step) => step.uses === './.github/actions/verify-trust-boundary',
            )?.with,
            expected: ciVerifierInputs,
            location: `ci.jobs.${jobName}.verify-trust-boundary.with`,
        })),
        {
            actual: releaseWorkflow.jobs.release.steps?.find(
                (step) => step.uses === './.github/actions/verify-trust-boundary',
            )?.with,
            expected: releaseVerifierInputs,
            location: 'release.jobs.release.verify-trust-boundary.with',
        },
    ];

    return cases.flatMap(({ actual, expected, location }) =>
        normalizeMapping(actual) === normalizeMapping(expected) ? [] : location,
    );
}

describe('CI trust policy', () => {
    it('binds every pre-checkout trust expression to the repository policy', () => {
        const mismatches = trustExpressionMismatches();

        expect(mismatches, `Trust condition mismatches: ${mismatches.join(', ')}`).toEqual([]);
    });

    it('reports every pre-checkout expression affected by an actor policy change', () => {
        const mismatches = trustExpressionMismatches({
            ...policy,
            trustedActor: 'replacement-owner',
        });

        expect(mismatches).toEqual([
            'ci.jobs.retry-policy.if',
            'ci.jobs.ci.env.TRUSTED_EVENT',
            'release.jobs.release.if',
        ]);
    });

    it('uses one shared runtime verifier instead of copied shell conditions', () => {
        const ciVerifierCount = Object.values(ciWorkflow.jobs)
            .flatMap((job) => job.steps ?? [])
            .filter((step) => step.uses === './.github/actions/verify-trust-boundary').length;
        const releaseVerifierCount = (releaseWorkflow.jobs.release.steps ?? []).filter(
            (step) => step.uses === './.github/actions/verify-trust-boundary',
        ).length;

        expect(ciVerifierCount).toBe(3);
        expect(releaseVerifierCount).toBe(1);
        const inputMismatches = verifierInputMismatches();
        expect(
            inputMismatches,
            `Trust verifier input mismatches: ${inputMismatches.join(', ')}`,
        ).toEqual([]);

        const verifierStep = verifierActionDocument.runs.steps[0];
        expect(verifierStep.env).toEqual({
            EVENT_ACTOR: '${{ inputs.actor }}',
            EVENT_NAME: '${{ inputs.event-name }}',
            EVENT_REF: '${{ inputs.event-ref }}',
            EVENT_REPOSITORY: '${{ inputs.event-repository }}',
            PR_AUTHOR: '${{ inputs.pull-request-author }}',
            TRIGGERING_ACTOR: '${{ inputs.triggering-actor }}',
        });
        const requiredChecks = [
            'policy=.github/ci-trust-policy.json',
            'test "$EVENT_ACTOR" = "$trusted_actor"',
            'test "$TRIGGERING_ACTOR" = "$trusted_actor"',
            'test "$EVENT_REPOSITORY" = "$GITHUB_REPOSITORY"',
            'test "$PR_AUTHOR" = "$trusted_actor"',
            'test "$EVENT_REF" = "$push_ref"',
            'test "$EVENT_NAME" = "$workflow_dispatch_event"',
            'test "$RUNNER_ENVIRONMENT" = self-hosted',
            'test "$RUNNER_OS" = macOS',
            'test "$RUNNER_ARCH" = ARM64',
        ];
        const missingChecks = requiredChecks.filter(
            (requiredCheck) => !verifierStep.run.includes(requiredCheck),
        );
        expect(missingChecks, `Missing runtime trust checks: ${missingChecks.join(', ')}`).toEqual(
            [],
        );
        expect(verifierAction).not.toContain(policy.trustedActor);
    });

    it('does not duplicate the owner trust expression in the downstream E2E gate', () => {
        const expression = ciWorkflow.jobs.e2e.if ?? '';

        expect(expression).not.toContain('github.actor');
        expect(expression).not.toContain('github.triggering_actor');
        expect(expression).not.toContain('github.event.pull_request.user.login');
    });
});
