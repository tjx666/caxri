import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = await readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const setupAction = await readFile(
    new URL('../../.github/actions/setup-caxri-job/action.yml', import.meta.url),
    'utf8',
);
const trustAction = await readFile(
    new URL('../../.github/actions/verify-trust-boundary/action.yml', import.meta.url),
    'utf8',
);
const checksWorktree = await readFile(new URL('../ci-checks-worktree.ts', import.meta.url), 'utf8');

interface WorkflowJob {
    'if'?: string;
    'needs'?: string[] | string;
    'runs-on': unknown;
}

interface WorkflowDocument {
    jobs: Record<string, WorkflowJob>;
    permissions: Record<string, string>;
}

const document = parse(workflow) as WorkflowDocument;

describe('CI workflow contract', () => {
    it('keeps automatic events on read-only hosted checks without a full E2E trigger', () => {
        expect(workflow).toContain('pull_request:');
        expect(workflow).toContain('push:');
        expect(workflow).not.toContain('schedule:');
        expect(document.permissions).toEqual({ actions: 'read', contents: 'read' });
        expect(document.jobs['retry-policy']['runs-on']).toBe('macos-15');
        expect(document.jobs.checks['runs-on']).toBe('macos-15');
        expect(document.jobs.ci['runs-on']).toBe('ubuntu-latest');
        expect(document.jobs.e2e.if).toContain("github.event_name == 'workflow_dispatch'");
        expect(document.jobs.e2e.if).not.toContain("github.event_name == 'pull_request'");
        expect(document.jobs.e2e.if).not.toContain("github.event_name == 'push'");
        expect(document.jobs.e2e.if).toContain("inputs.validation_target == 'self-hosted-final'");
        expect(document.jobs.e2e.if).toContain("inputs.validation_target == 'hosted-full'");
        expect(workflow).toContain('full E2E never runs automatically');
    });

    it('runs a targeted hosted smoke without turning it into the full E2E suite', () => {
        const smoke = document.jobs['hosted-smoke'];
        const source = workflow.match(/\n {2}hosted-smoke:\n([\s\S]*?)\n {2}e2e:/u)?.[1] ?? '';

        expect(smoke['runs-on']).toBe('macos-15');
        expect(smoke.if).toContain("inputs.validation_target == 'hosted-smoke'");
        expect(source).toContain('run: bun run test:smoke');
        expect(source).not.toContain('bun run test:e2e');
        expect(source).not.toContain('scripts/run-e2e-pools.ts');
    });

    it('keeps the final private self-hosted and first public hosted full routes explicit', () => {
        const e2e = workflow.match(/\n {2}e2e:\n([\s\S]*?)\n {2}ci:/u)?.[1] ?? '';

        expect(e2e).toContain(
            `runs-on: \${{ inputs.validation_target == 'self-hosted-final' && fromJSON('["self-hosted","macOS","ARM64","caxri-e2e"]') || 'macos-15' }}`,
        );
        expect(e2e).toContain('test "$REPOSITORY_VISIBILITY" = private');
        expect(e2e).toContain('test "$REPOSITORY_VISIBILITY" = public');
        expect(e2e).toContain('bun run scripts/run-e2e-pools.ts --pool parallel-safe');
        expect(e2e).toContain('bun run scripts/run-e2e-pools.ts --pool desktop-exclusive');
        expect(e2e).toContain('bun run scripts/run-e2e-pools.ts --pool control');
        expect(e2e).toContain("runner.environment == 'self-hosted'");
        expect(e2e).toContain('bun run scripts/self-hosted-runner.ts cleanup');
    });

    it('separates event trust from runner hardware trust', () => {
        const retry = workflow.match(/\n {2}retry-policy:\n([\s\S]*?)\n {2}checks:/u)?.[1] ?? '';
        const checks = workflow.match(/\n {2}checks:\n([\s\S]*?)\n {2}hosted-smoke:/u)?.[1] ?? '';

        for (const job of [retry, checks]) {
            expect(job.indexOf('Verify hosted runner boundary before checkout')).toBeLessThan(
                job.indexOf('actions/checkout@'),
            );
            expect(job).toContain('test "$RUNNER_ENVIRONMENT" = github-hosted');
            expect(job).toContain('test "$RUNNER_OS" = macOS');
            expect(job).toContain('test "$RUNNER_ARCH" = ARM64');
            expect(job).toContain('uses: ./.github/actions/verify-trust-boundary');
            expect(job).toContain("allow-external-pull-request: 'true'");
        }
        expect(trustAction).not.toContain('test "$RUNNER_ENVIRONMENT"');
        expect(trustAction).not.toContain('test "$RUNNER_OS"');
        expect(trustAction).not.toContain('test "$RUNNER_ARCH"');
    });

    it('installs exact tools on a cold hosted runner without persistent runner assumptions', () => {
        expect(setupAction).toContain('node-version: ${{ steps.tool_versions.outputs.node }}');
        expect(setupAction).toContain('version: ${{ steps.tool_versions.outputs.pnpm }}');
        expect(setupAction).toContain('dest: ${{ runner.temp }}/caxri-pnpm');
        expect(setupAction).toContain(
            'npm install --global --no-audit --no-fund "bun@$bun_version"',
        );
        expect(setupAction).toContain("runner.environment == 'github-hosted'");
        expect(setupAction).toContain('cache_root="$RUNNER_TEMP/caxri"');
        expect(setupAction).toContain('echo "CAXRI_CACHE_ROOT=$cache_root" >> "$GITHUB_ENV"');
        expect(setupAction).toContain("runner.environment == 'self-hosted'");
        expect(setupAction).toContain(
            'bun_directory="$RUNNER_TOOL_CACHE/caxri/bun/$bun_version/bin"',
        );
        expect(setupAction).toContain('bun run scripts/self-hosted-runner.ts prepare');
        expect(checksWorktree).toContain("requiredEnvironment(environment, 'CAXRI_CACHE_ROOT')");
        expect(checksWorktree).not.toContain(
            "requiredEnvironment(environment, 'RUNNER_TOOL_CACHE')",
        );
    });

    it('pins and verifies the Android release toolchain explicitly', () => {
        expect(setupAction).toContain('JAVA_HOME_17_arm64');
        expect(setupAction).toContain('"build-tools;35.0.0"');
        expect(setupAction).toContain('"build-tools;36.0.0"');
        expect(setupAction).toContain('"platforms;android-36"');
        expect(setupAction).toContain('"ndk;27.1.12297006"');
        expect(setupAction).toContain('"cmake;3.22.1"');
        expect(setupAction).toContain('test -x "$sdk_root/cmake/3.22.1/bin/ninja"');
    });

    it('keeps external pull requests on a read-only token without secrets or write permission', () => {
        expect(workflow).toContain('permissions:\n  actions: read\n  contents: read');
        expect(workflow).not.toContain('pull_request_target:');
        expect(workflow).not.toContain('contents: write');
        expect(workflow).not.toContain('issues: write');
        expect(workflow).not.toContain('secrets.');
        expect(workflow).toContain('GITHUB_TOKEN: ${{ github.token }}');
        expect(workflow.match(/persist-credentials: false/gu)?.length).toBeGreaterThanOrEqual(4);
        expect(trustAction).toContain('external_pull_request=true');
        expect(trustAction).toContain('test "$ALLOW_EXTERNAL_PULL_REQUEST" = true');
    });

    it('rejects the transitional self-hosted route before scheduling it for a public repository', () => {
        expect(document.jobs.e2e.if).toContain(
            "inputs.validation_target != 'self-hosted-final' || github.event.repository.private == true",
        );
    });

    it('keeps the stable gate aware of every explicit route', () => {
        const gate = workflow.match(/\n {2}ci:\n([\s\S]*)$/u)?.[1] ?? '';

        expect(document.jobs.ci.needs).toEqual(['retry-policy', 'checks', 'hosted-smoke', 'e2e']);
        expect(gate).toContain('hosted-smoke)');
        expect(gate).toContain('self-hosted-final|hosted-full)');
        expect(gate).toContain('automated|checks-only)');
        expect(gate).toContain('test "$E2E_RESULT" = skipped');
        expect(gate).toContain('test "$E2E_RESULT" = success');
    });
});
