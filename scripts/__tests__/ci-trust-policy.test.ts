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
        scheduleEvent: string;
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
    id?: string;
    name?: string;
    run?: string;
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
    'policy-domain': 'ci',
    'pull-request-author': '${{ github.event.pull_request.user.login || github.actor }}',
    'triggering-actor': '${{ github.triggering_actor }}',
};
const releaseVerifierInputs = {
    'actor': '${{ github.event.workflow_run.actor.login }}',
    'event-name': '${{ github.event.workflow_run.event }}',
    'event-ref': 'refs/heads/${{ github.event.workflow_run.head_branch }}',
    'event-repository': '${{ github.event.workflow_run.head_repository.full_name }}',
    'policy-domain': 'release',
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
          github.triggering_actor == ${actor} &&
          startsWith(github.event.head_commit.message, '${candidatePolicy.release.titlePrefix}')
        ) || (
          github.event_name == '${candidatePolicy.ci.scheduleEvent}' &&
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

/**
 * `linux-natives` also runs on a manual rehearsal from main, under the same trusted-actor rule as a CI dispatch. It
 * reads no secrets and runs on GitHub-hosted runners; `release` itself stays release-commit only.
 */
function releaseNativesTrustExpression(candidatePolicy: TrustPolicy = policy): string {
    const actor = `'${candidatePolicy.trustedActor}'`;

    return `
        (
          github.event_name == '${candidatePolicy.ci.workflowDispatchEvent}' &&
          github.ref == '${candidatePolicy.ci.pushRef}' &&
          github.actor == ${actor} &&
          github.triggering_actor == ${actor}
        ) || (${releaseTrustExpression(candidatePolicy)})
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
            actual: releaseWorkflow.jobs['linux-natives'].if,
            expected: releaseNativesTrustExpression(candidatePolicy),
            location: 'release.jobs.linux-natives.if',
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
            'release.jobs.linux-natives.if',
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

        expect(ciVerifierCount).toBe(4);
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
            POLICY_DOMAIN: '${{ inputs.policy-domain }}',
            PR_AUTHOR: '${{ inputs.pull-request-author }}',
            TRIGGERING_ACTOR: '${{ inputs.triggering-actor }}',
        });
        const requiredChecks = [
            'policy=.github/ci-trust-policy.json',
            'test "$EVENT_ACTOR" = "$trusted_actor"',
            'test "$TRIGGERING_ACTOR" = "$trusted_actor"',
            'test "$EVENT_REPOSITORY" = "$GITHUB_REPOSITORY"',
            'test "$POLICY_DOMAIN" = ci || test "$POLICY_DOMAIN" = release',
            'test "$PR_AUTHOR" = "$trusted_actor"',
            'test "$EVENT_REF" = "$push_ref"',
            'test "$EVENT_REF" = "refs/heads/$release_branch"',
            'test "$EVENT_NAME" = "$workflow_dispatch_event"',
            'elif [[ "$EVENT_NAME" == "$schedule_event" ]]; then',
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

    it('verifies the runner platform before checkout on privileged desktop jobs', () => {
        const cases = [
            { job: ciWorkflow.jobs.e2e, location: 'ci.jobs.e2e' },
            { job: releaseWorkflow.jobs.release, location: 'release.jobs.release' },
        ];

        for (const { job, location } of cases) {
            const steps = job.steps ?? [];
            const guardIndex = steps.findIndex(
                (step) => step.name === 'Verify runner boundary before checkout',
            );
            const checkoutIndex = steps.findIndex((step) =>
                step.uses?.startsWith('actions/checkout@'),
            );
            const guard = steps[guardIndex]?.run ?? '';

            expect(guardIndex, `${location} pre-checkout runner guard`).toBeGreaterThanOrEqual(0);
            expect(guardIndex, `${location} guard ordering`).toBeLessThan(checkoutIndex);
            expect(guard).toContain('test "$RUNNER_ENVIRONMENT" = self-hosted');
            expect(guard).toContain('test "$RUNNER_OS" = macOS');
            expect(guard).toContain('test "$RUNNER_ARCH" = ARM64');
        }
    });
});
