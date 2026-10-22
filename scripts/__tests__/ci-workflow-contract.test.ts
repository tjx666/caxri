import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = await readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const performanceTrendWorkflow = await readFile(
    new URL('../../.github/workflows/performance-trend.yml', import.meta.url),
    'utf8',
);
const performanceBaseline = JSON.parse(
    await readFile(new URL('../performance-baseline.json', import.meta.url), 'utf8'),
) as { armed: boolean; metrics: Record<string, unknown>; provenance: string };
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
        expect(document.jobs['retry-policy']['runs-on']).toBe('ubuntu-latest');
        expect(document.jobs.checks['runs-on']).toBe(
            "${{ needs.retry-policy.outputs.checks_scope == 'full' && 'ubuntu-latest' || 'macos-15' }}",
        );
        expect(document.jobs.unit['runs-on']).toBe('macos-15');
        expect(document.jobs.lint['runs-on']).toBe('ubuntu-latest');
        expect(document.jobs.ci['runs-on']).toBe('ubuntu-latest');
        expect(document.jobs.e2e['runs-on']).toBe('macos-15');
        expect(document.jobs.e2e.if).toContain("github.event_name == 'workflow_dispatch'");
        expect(document.jobs.e2e.if).not.toContain("github.event_name == 'pull_request'");
        expect(document.jobs.e2e.if).not.toContain("github.event_name == 'push'");
        expect(document.jobs.e2e.if).toContain("inputs.validation_target == 'hosted-full'");
        expect(workflow).not.toContain('self-hosted-final');
        expect(workflow).toContain('full E2E never runs automatically');
    });

    it('runs a targeted hosted smoke without turning it into the full E2E suite', () => {
        const smoke = document.jobs['hosted-smoke'];
        const source = workflow.match(/\n {2}hosted-smoke:\n([\s\S]*?)\n {2}e2e:/u)?.[1] ?? '';

        expect(smoke['runs-on']).toBe('macos-15');
        expect(smoke.if).toContain("inputs.validation_target == 'hosted-smoke'");
        expect(source).toContain('run: bun run test:smoke');
        expect(source).toContain('CAXRI_E2E_CLIPBOARD_PROTECTION: skip-hosted');
        expect(source).not.toContain('actions/upload-artifact@');
        expect(source).not.toContain('bun run test:e2e');
        expect(source).not.toContain('scripts/run-e2e-pools.ts');
    });

    it('keeps the explicitly authorized full E2E route hosted and manual', () => {
        const e2e = workflow.match(/\n {2}e2e:\n([\s\S]*?)\n {2}ci:/u)?.[1] ?? '';

        expect(e2e).toContain('runs-on: macos-15');
        expect(e2e).toContain('test "$RUNNER_ENVIRONMENT" = github-hosted');
        expect(e2e.indexOf('Prepare hosted E2E temporary root')).toBeLessThan(
            e2e.indexOf('actions/checkout@'),
        );
        expect(e2e).toContain('[[ "$owner" =~ ^caxri-[0-9]+-[0-9]+-e2e$ ]]');
        expect(e2e).toContain(
            'CAXRI_RUNNER_OWNER: caxri-${{ github.run_id }}-${{ github.run_attempt }}-e2e',
        );
        expect(e2e).not.toContain('CAXRI_DESKTOP_LEASE_OWNER');
        expect(e2e).toContain('temporary_root="/private/tmp/$owner"');
        expect(e2e).toContain('> "$temporary_root/.caxri-owner"');
        expect(e2e).toContain('echo "TMPDIR=$temporary_root"');
        expect(e2e).toContain('name: Remove hosted E2E temporary root');
        expect(e2e).toContain('cat "$temporary_root/.caxri-owner"');
        expect(e2e).toContain('rm -rf -- "$temporary_root"');
        expect(e2e).toContain('bun run scripts/run-e2e-pools.ts --pool parallel-safe');
        expect(e2e).toContain('bun run scripts/run-e2e-pools.ts --pool desktop-exclusive');
        expect(e2e).toContain('bun run scripts/run-e2e-pools.ts --pool control');
        expect(e2e).toContain('run: bun run benchmark:renderer');
        expect(e2e).toContain("if: always() && steps.renderer-performance.outcome != 'skipped'");
        expect(performanceBaseline.armed).toBe(false);
        expect(performanceBaseline.provenance).toContain('self-hosted CI runs');
        expect(Object.keys(performanceBaseline.metrics).length).toBeGreaterThan(0);
        expect(e2e).not.toContain('self-hosted');
        expect(e2e).not.toContain('repository.visibility');
    });

    it('separates event trust from runner hardware trust', () => {
        const retry = workflow.match(/\n {2}retry-policy:\n([\s\S]*?)\n {2}checks:/u)?.[1] ?? '';
        const checks = workflow.match(/\n {2}checks:\n([\s\S]*?)\n {2}lint:/u)?.[1] ?? '';
        const lint = workflow.match(/\n {2}lint:\n([\s\S]*?)\n {2}unit:/u)?.[1] ?? '';
        const unit = workflow.match(/\n {2}unit:\n([\s\S]*?)\n {2}hosted-smoke:/u)?.[1] ?? '';

        for (const job of [retry, checks, lint]) {
            expect(job).toContain('test "$RUNNER_OS" = Linux');
            expect(job).toContain('test "$RUNNER_ARCH" = X64');
        }
        for (const job of [checks, unit]) {
            expect(job).toContain('test "$RUNNER_OS" = macOS');
            expect(job).toContain('test "$RUNNER_ARCH" = ARM64');
        }
        for (const job of [retry, checks, lint, unit]) {
            expect(job.indexOf('Verify hosted runner boundary before checkout')).toBeLessThan(
                job.indexOf('actions/checkout@'),
            );
            expect(job).toContain('test "$RUNNER_ENVIRONMENT" = github-hosted');
            expect(job).toContain('uses: ./.github/actions/verify-trust-boundary');
            expect(job).toContain("allow-external-pull-request: 'true'");
            expect(job).not.toContain('CAXRI_DESKTOP_LEASE_OWNER');
            expect(job).not.toContain('CAXRI_RUNNER_OWNER');
        }
        expect(workflow).not.toContain('CAXRI_DESKTOP_LEASE_OWNER');
        expect(trustAction).not.toContain('test "$RUNNER_ENVIRONMENT"');
        expect(trustAction).not.toContain('test "$RUNNER_OS"');
        expect(trustAction).not.toContain('test "$RUNNER_ARCH"');
    });

    it('fails closed off GitHub-hosted runners and installs tools without persistent assumptions', () => {
        const checks = workflow.match(/\n {2}checks:\n([\s\S]*?)\n {2}hosted-smoke:/u)?.[1] ?? '';
        const e2e = workflow.match(/\n {2}e2e:\n([\s\S]*?)\n {2}ci:/u)?.[1] ?? '';

        expect(setupAction.indexOf('Verify GitHub-hosted runner boundary')).toBeLessThan(
            setupAction.indexOf('Read mise tool versions'),
        );
        expect(setupAction).toContain('test "$RUNNER_ENVIRONMENT" = github-hosted');
        expect(setupAction).toContain('node-version: ${{ steps.tool_versions.outputs.node }}');
        expect(setupAction).toContain('version: ${{ steps.tool_versions.outputs.pnpm }}');
        expect(setupAction).toContain('dest: ${{ runner.temp }}/caxri-pnpm');
        expect(setupAction).toContain(
            'npm install --global --no-audit --no-fund "bun@$bun_version"',
        );
        expect(setupAction).toContain('cache_root="$RUNNER_TEMP/caxri"');
        expect(setupAction).toContain('echo "CAXRI_CACHE_ROOT=$cache_root" >> "$GITHUB_ENV"');
        expect(setupAction).not.toContain('runner.environment');
        expect(setupAction).not.toContain('RUNNER_TOOL_CACHE');
        expect(setupAction).not.toContain('self-hosted-runner.ts');
        expect(setupAction).toContain('brew install ffmpeg');
        expect(setupAction).toContain('command -v ffprobe');
        expect(setupAction).toContain('libx264');
        expect(checks).toContain(
            "install-media-tools: ${{ needs.retry-policy.outputs.checks_scope == 'focused-source' || needs.retry-policy.outputs.checks_scope == 'affected' }}",
        );
        expect(e2e).toContain("install-media-tools: 'true'");
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

    it('contains no active self-hosted routing or runner preparation', () => {
        expect(workflow).not.toContain('self-hosted');
        expect(workflow).not.toContain('fromJSON(\'["self-hosted"');
        expect(setupAction).not.toContain('self-hosted');
        expect(setupAction).not.toContain('scripts/self-hosted-runner.ts');
    });

    it('runs sharded Vitest and Linux ESLint beside the remaining platform gates', () => {
        const unit = parse(workflow) as {
            jobs: Record<
                string,
                {
                    if?: string;
                    needs?: string;
                    steps: Array<{ env?: Record<string, string>; name?: string; run?: string }>;
                    strategy?: { matrix?: { shard?: string[] } };
                }
            >;
        };
        const job = unit.jobs.unit;
        expect(job.needs).toBe('retry-policy');
        expect(job.strategy?.matrix?.shard).toEqual(['1/3', '2/3', '3/3']);
        expect(job.if).toContain("needs.retry-policy.outputs.checks_scope == 'full'");
        expect(job.if).toContain("needs.retry-policy.outputs.checks_scope == 'affected'");
        const run = job.steps.find((step) => step.run === 'bun run scripts/run-ci-unit-tests.ts');
        expect(run?.env?.CAXRI_VITEST_SHARD).toBe('${{ matrix.shard }}');
        expect(workflow).toContain(
            'bun run scripts/ci-platform-checks.ts --skip-node-pty-preparation --skip-vitest --skip-eslint',
        );
        const lint = unit.jobs.lint;
        expect(lint.needs).toBe('retry-policy');
        expect(lint.if).toContain("needs.retry-policy.outputs.checks_scope == 'full'");
        expect(lint.if).not.toContain("'affected'");
        expect(lint.steps.find((step) => step.name === 'Run ESLint')?.env?.ESLINT_CONCURRENCY).toBe(
            'auto',
        );
        // The optimized hosted-full route runs every check inside E2E, so unit and lint skip exactly when checks does.
        for (const condition of [
            "inputs.validation_target != 'hosted-full'",
            "needs.retry-policy.outputs.e2e_profile != 'optimized'",
        ]) {
            expect(job.if).toContain(condition);
            expect(lint.if).toContain(condition);
            expect(unit.jobs.checks.if).toContain(condition);
        }
    });

    it('keeps the stable gate aware of every explicit route', () => {
        const gate = workflow.match(/\n {2}ci:\n([\s\S]*)$/u)?.[1] ?? '';

        expect(document.jobs.ci.needs).toEqual([
            'retry-policy',
            'checks',
            'lint',
            'unit',
            'hosted-smoke',
            'e2e',
        ]);
        expect(gate).toContain('test "$UNIT_RESULT" = success');
        expect(gate).toContain('test "$UNIT_RESULT" = skipped');
        expect(gate).toContain('test "$LINT_RESULT" = success');
        expect(gate).toContain('test "$LINT_RESULT" = skipped');
        expect(gate).toContain('hosted-smoke)');
        expect(gate).toContain('hosted-full)');
        expect(gate).not.toContain('self-hosted-final');
        expect(gate).toContain('automated|checks-only)');
        expect(gate).toContain('test "$E2E_RESULT" = skipped');
        expect(gate).toContain('test "$E2E_RESULT" = success');
    });

    it('keeps performance trend comparison manual while the hosted baseline is unarmed', () => {
        expect(performanceTrendWorkflow).toContain('workflow_dispatch:');
        expect(performanceTrendWorkflow).not.toContain('schedule:');
        expect(performanceTrendWorkflow).toContain('dispatch-only');
    });
});
