import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const policy = JSON.parse(
    await readFile(new URL('../../.github/ci-trust-policy.json', import.meta.url), 'utf8'),
) as { ci: { pushRef: string }; trustedActor: string };
const ciSource = await readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const releaseSource = await readFile(
    new URL('../../.github/workflows/release.yml', import.meta.url),
    'utf8',
);
const verifierSource = await readFile(
    new URL('../../.github/actions/verify-trust-boundary/action.yml', import.meta.url),
    'utf8',
);

interface WorkflowStep {
    name?: string;
    uses?: string;
    with?: Record<string, string>;
}

interface WorkflowDocument {
    jobs: Record<string, { if?: string; steps?: WorkflowStep[] }>;
}

const ci = parse(ciSource) as WorkflowDocument;
const release = parse(releaseSource) as WorkflowDocument;

function verifier(job: WorkflowDocument['jobs'][string]): WorkflowStep | undefined {
    return job.steps?.find((step) => step.uses === './.github/actions/verify-trust-boundary');
}

describe('CI trust policy', () => {
    it('keeps privileged dispatch and release routes bound to the configured owner', () => {
        expect(ci.jobs['retry-policy'].if).toContain("github.event_name == 'workflow_dispatch'");
        expect(ci.jobs['retry-policy'].if).toContain(`github.actor == '${policy.trustedActor}'`);
        expect(ci.jobs['retry-policy'].if).toContain(
            `github.triggering_actor == '${policy.trustedActor}'`,
        );
        expect(ci.jobs['retry-policy'].if).toContain(`github.ref == '${policy.ci.pushRef}'`);
        expect(release.jobs.release.if).toContain(`== '${policy.trustedActor}'`);
    });

    it('allows untrusted pull request source only in read-only hosted jobs', () => {
        for (const name of ['retry-policy', 'checks']) {
            expect(verifier(ci.jobs[name])?.with?.['allow-external-pull-request']).toBe('true');
        }
        expect(
            verifier(ci.jobs['hosted-smoke'])?.with?.['allow-external-pull-request'],
        ).toBeUndefined();
        expect(verifier(ci.jobs.e2e)?.with?.['allow-external-pull-request']).toBeUndefined();
        expect(ciSource).toContain('permissions:\n  actions: read\n  contents: read');
        expect(ciSource).not.toContain('pull_request_target:');
    });

    it('verifies event trust without conflating runner hardware', () => {
        expect(verifierSource).toContain('external_pull_request=false');
        expect(verifierSource).toContain('test "$ALLOW_EXTERNAL_PULL_REQUEST" = true');
        expect(verifierSource).toContain('test "$EVENT_ACTOR" = "$trusted_actor"');
        expect(verifierSource).toContain('test "$TRIGGERING_ACTOR" = "$trusted_actor"');
        expect(verifierSource).toContain('test "$EVENT_REPOSITORY" = "$GITHUB_REPOSITORY"');
        expect(verifierSource).not.toContain('test "$RUNNER_ENVIRONMENT"');
        expect(verifierSource).not.toContain('test "$RUNNER_OS"');
        expect(verifierSource).not.toContain('test "$RUNNER_ARCH"');
        expect(verifierSource).not.toContain(policy.trustedActor);
    });

    it('checks hardware before checkout on every desktop execution route', () => {
        for (const name of ['retry-policy', 'checks', 'hosted-smoke', 'e2e']) {
            const steps = ci.jobs[name].steps ?? [];
            const guard = steps.findIndex((step) => step.name?.includes('runner boundary'));
            const checkout = steps.findIndex((step) => step.uses?.startsWith('actions/checkout@'));

            expect(guard, `${name} runner guard`).toBeGreaterThanOrEqual(0);
            expect(guard, `${name} guard ordering`).toBeLessThan(checkout);
        }
    });

    it('keeps release event verification wired after checkout', () => {
        expect(verifier(release.jobs.release)).toBeDefined();
        expect(releaseSource).toContain('persist-credentials: false');
    });
});
