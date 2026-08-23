import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { execFileAsync } from '../exec';

const workflow = await readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const setupAction = await readFile(
    new URL('../../.github/actions/setup-caxri-job/action.yml', import.meta.url),
    'utf8',
);
const checksWorktree = await readFile(new URL('../ci-checks-worktree.ts', import.meta.url), 'utf8');
const concurrentValidation = await readFile(
    new URL('../ci-concurrent-validation.ts', import.meta.url),
    'utf8',
);
const platformChecks = await readFile(new URL('../ci-platform-checks.ts', import.meta.url), 'utf8');
const bunVersion = (await readFile(new URL('../../.bun-version', import.meta.url), 'utf8')).trim();
const packageManifest = JSON.parse(
    await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
) as { scripts: Record<string, string> };
const setupActionDocument = parse(setupAction) as {
    runs: { steps: Array<{ name?: string; run?: string }> };
};

describe('CI workflow contract', () => {
    it('evaluates retry trailers on the pushed PR head instead of the synthetic merge commit', () => {
        const retryPolicyJob = workflow.match(/\n {2}retry-policy:\n([\s\S]*?)\n {2}checks:/u)?.[1];

        expect(retryPolicyJob).toContain('fetch-depth: 0');
        expect(retryPolicyJob).toContain("github.event_name == 'pull_request'");
        expect(retryPolicyJob).toContain("format('retry-policy / pr-{0} / base-{1}'");
        expect(retryPolicyJob).toContain("format('retry-policy / {0}', github.ref_name)");
        expect(retryPolicyJob).not.toContain('pr-${{ github.event.pull_request.number || 0 }}');
        expect(retryPolicyJob).toContain(
            'ref: ${{ github.event.pull_request.head.sha || github.sha }}',
        );
        expect(retryPolicyJob).toContain('reused_e2e_run:');
        expect(retryPolicyJob).toContain('reused_e2e_head:');
    });

    it('uses one shared setup action with runner-local caches and pinned tools', () => {
        expect(workflow.match(/uses: \.\/\.github\/actions\/setup-caxri-job/gu)).toHaveLength(3);
        expect(workflow).not.toContain('actions/cache@');
        expect(setupAction).toContain(
            'uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7',
        );
        expect(setupAction).toContain('name: Read mise tool versions');
        expect(setupAction).toContain('node-version: ${{ steps.tool_versions.outputs.node }}');
        expect(setupAction).toContain('package-manager-cache: false');
        expect(setupAction).toContain(
            'uses: pnpm/setup@c8e77b72cd6022852162c92aa10e7e72b7209c9b # v2',
        );
        expect(setupAction).toContain('version: ${{ steps.tool_versions.outputs.pnpm }}');
        expect(setupAction).toContain("steps.pnpm_toolchain.outputs.cached != 'true'");
        expect(setupAction).toContain(
            'dest: ${{ runner.tool_cache }}/caxri/pnpm/${{ steps.tool_versions.outputs.pnpm }}-node-${{ steps.tool_versions.outputs.node }}',
        );
        expect(setupAction).toContain('test "$(node --version)" = "v$CAXRI_NODE_VERSION"');
        expect(setupAction).toContain('test "$(pnpm --version)" = "$CAXRI_PNPM_VERSION"');
        expect(setupAction).not.toContain('github.run_id');
        expect(setupAction).toContain('install: false');
        expect(setupAction).toContain('cache: false');
        expect(setupAction).toContain(
            'bun_directory="$RUNNER_TOOL_CACHE/caxri/bun/$bun_version/bin"',
        );
        expect(setupAction).not.toContain('oven-sh/setup-bun');
        expect(setupAction).toContain('cache_root="$RUNNER_TOOL_CACHE/caxri"');
        expect(setupAction).toContain('CAXRI_CACHE_STATE');
        expect(setupAction).toContain(
            'pnpm install --frozen-lockfile --ignore-scripts --prefer-offline --no-runtime',
        );
        expect(setupAction).toContain('pnpm rebuild electron');
        expect(setupAction).toContain('bun run rebuild');
        expect(bunVersion).toBe('1.3.14');
        expect(workflow).toContain('Electron native compatibility');
        expect(workflow).toContain('bun run spike:native');
        expect(workflow).toContain(
            "CAXRI_VITEST_PARTITION: ${{ inputs.vitest_partition || 'optimized' }}",
        );
        expect(workflow).toContain(
            "CAXRI_VITEST_MAX_WORKERS: ${{ inputs.vitest_max_workers || '2' }}",
        );
        expect(workflow).toContain(
            "CAXRI_E2E_PARALLEL_WORKERS: ${{ inputs.e2e_parallel_workers || '3' }}",
        );
        expect(workflow).toContain(
            'Vitest full suite partition=${CAXRI_VITEST_PARTITION} workers=${CAXRI_VITEST_MAX_WORKERS}',
        );
        expect(workflow).toContain('CAXRI_VALIDATION_ENV');
        expect(workflow).toContain('NODE_VERSION="$(node --version)"');
        expect(workflow).toContain('node: process.env.NODE_VERSION');
        expect(workflow).toContain('lockfileSha256: process.env.LOCKFILE_SHA256');
        expect(workflow.match(/--label "Electron Vite build" -- bun run build/gu)).toHaveLength(1);
        expect(
            workflow.match(
                /--label "Bundle budget gate" -- bun run scripts\/ci-bundle-budget\.ts/gu,
            ),
        ).toHaveLength(1);
        expect(packageManifest.scripts.rebuild).toContain('--only better-sqlite3,node-pty');
        expect(packageManifest.scripts.rebuild).not.toContain('@parcel/watcher');
        expect(workflow.match(/install-electron:/gu)).toHaveLength(2);
        expect(workflow.match(/rebuild-native:/gu)).toHaveLength(2);
    });

    it('always tears down the self-hosted boundary, including a partial setup failure', () => {
        expect(workflow.match(/name: Clean self-hosted runner boundary/gu)).toHaveLength(3);
        expect(
            workflow.match(/name: Clean self-hosted runner boundary\n {8}if: always\(\)/gu),
        ).toHaveLength(3);
        expect(workflow).not.toContain("steps.setup.outputs.prepared == 'true'");
    });

    it('recovers an empty persistent Prettier cache before reuse', async () => {
        const cacheStep = setupActionDocument.runs.steps.find(
            (step) => step.name === 'Configure runner-local caches',
        );
        const root = await mkdtemp(join(tmpdir(), 'caxri-prettier-cache-'));
        const workspace = join(root, 'workspace');
        const toolCache = join(root, 'tool-cache');
        const pnpmStore = join(toolCache, 'caxri', 'pnpm-store');
        const persistentCache = join(toolCache, 'caxri', 'prettier');
        const githubEnvironment = join(root, 'github-env');
        const githubSummary = join(root, 'github-summary');

        try {
            expect(cacheStep?.run).toBeTruthy();
            await mkdir(workspace, { recursive: true });
            await mkdir(join(toolCache, 'caxri'), { recursive: true });
            await mkdir(pnpmStore, { recursive: true });
            await writeFile(join(pnpmStore, 'cache-entry'), 'warm');
            await writeFile(persistentCache, '');
            await writeFile(githubEnvironment, '');
            await writeFile(githubSummary, '');

            const { stdout } = await execFileAsync(
                'bash',
                ['-e', '-o', 'pipefail', '-c', cacheStep?.run ?? 'exit 1'],
                {
                    cwd: workspace,
                    env: {
                        ...process.env,
                        GITHUB_ENV: githubEnvironment,
                        GITHUB_STEP_SUMMARY: githubSummary,
                        RUNNER_TOOL_CACHE: toolCache,
                    },
                },
            );

            expect(await readlink(join(workspace, '.cache', 'prettier'))).toBe(persistentCache);
            const cacheMetric = stdout
                .split('\n')
                .find((line) => line.startsWith('CAXRI_CACHE_STATE '));
            expect(JSON.parse(cacheMetric?.replace('CAXRI_CACHE_STATE ', '') ?? '')).toEqual({
                electron: 'cold',
                pnpm: 'warm',
                quality: 'warm',
            });
            expect(await readFile(githubEnvironment, 'utf8')).toContain(
                `PNPM_CONFIG_STORE_DIR=${pnpmStore}`,
            );
            await writeFile(join(workspace, 'fixture.js'), 'const value = 1;\n');
            await execFileAsync(
                fileURLToPath(new URL('../../node_modules/.bin/prettier', import.meta.url)),
                [
                    '--check',
                    'fixture.js',
                    '--cache',
                    '--cache-strategy',
                    'content',
                    '--cache-location',
                    '.cache/prettier',
                ],
                { cwd: workspace },
            );

            expect(JSON.parse(await readFile(persistentCache, 'utf8'))).toBeDefined();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('supports fail-closed focused checks and self-hosted control or optimized E2E profiles', () => {
        expect(workflow).not.toContain('runner_probe:');
        expect(workflow).not.toContain('e2e_runner:');
        expect(workflow).toContain("needs.retry-policy.outputs.checks_scope != 'skipped'");
        expect(workflow).toContain('if test "$CHECKS_SCOPE" = skipped; then');
        expect(workflow).toContain(
            'types: [opened, synchronize, reopened, converted_to_draft, ready_for_review]',
        );
        expect(workflow).toContain("needs.retry-policy.outputs.checks_scope == 'full'");
        expect(workflow).toContain('focused-skills');
        expect(workflow).toContain('run: bun run scripts/run-ci-focused-checks.ts');
        expect(workflow).toContain('- name: Run ESLint');
        expect(workflow).toContain("needs.retry-policy.outputs.run_e2e == 'true'");
        const interruptionIndex = workflow.indexOf('Desktop worker interruption recovery');
        const censusIndex = workflow.indexOf('Prove bounded E2E failure census');
        const optimizedPoolIndex = workflow.indexOf('--pool parallel-safe');

        expect(interruptionIndex).toBeGreaterThan(0);
        expect(censusIndex).toBeGreaterThan(interruptionIndex);
        expect(optimizedPoolIndex).toBeGreaterThan(censusIndex);
        expect(workflow).toContain('bun run scripts/run-e2e-failure-isolation.ts');
        expect(workflow).toContain('bun run scripts/run-e2e-census-fixture.ts');
        expect(workflow).toContain('name: e2e');
        expect(workflow).not.toContain('matrix.pool');
        expect(workflow).toContain('bun run scripts/run-e2e-pools.ts --pool parallel-safe');
        expect(workflow).toContain('bun run scripts/run-e2e-pools.ts --pool desktop-exclusive');
        expect(workflow).toContain('bun run scripts/run-e2e-pools.ts --pool control');
        expect(workflow).toContain(
            "if: always() && steps.e2e-build.outcome == 'success' && github.event_name == 'workflow_dispatch'",
        );
        expect(workflow).toContain('bun run scripts/run-ci-parity.ts');
        expect(workflow).toContain('id: parallel-safe');
        expect(workflow).toContain('id: desktop-exclusive');
        expect(workflow).toContain("steps.parallel-safe.outcome == 'failure' ||");
        expect(workflow).toContain("steps.parallel-safe-receipt.outcome == 'failure'");
        expect(workflow).toContain("steps.desktop-exclusive.outcome == 'failure' ||");
        expect(workflow).toContain("steps.desktop-exclusive-receipt.outcome == 'failure'");
        expect(workflow).toContain("steps.failure-isolation.outcome == 'failure'");
        expect(workflow).toContain("steps.failure-census.outcome == 'failure'");
        expect(workflow).toContain("steps.execution-receipt.outcome == 'failure'");
        expect(workflow).toContain('bun run scripts/report-e2e-manifest.ts');
    });

    it('runs focused repair specs before the complete E2E suite and exposes one stable gate', () => {
        const e2eJob = workflow.match(/\n {2}e2e:\n([\s\S]*?)\n {2}ci:/u)?.[1];
        const focusedIndex = workflow.indexOf('run: bun run scripts/run-e2e-repair.ts');
        const fullIndex = workflow.indexOf('bun run scripts/run-e2e-pools.ts --pool control');

        expect(focusedIndex).toBeGreaterThan(0);
        expect(fullIndex).toBeGreaterThan(focusedIndex);
        expect(e2eJob).toContain('ref: ${{ github.event.pull_request.head.sha || github.sha }}');
        expect(e2eJob).toContain(
            "if: always() && steps.e2e-build.outcome == 'success' && needs.retry-policy.outputs.e2e_profile == 'optimized'",
        );
        expect(e2eJob).toContain(
            "if: always() && steps.e2e-build.outcome == 'success' && needs.retry-policy.outputs.e2e_profile == 'control'",
        );
        expect(workflow).toContain('name: CI gate');
        expect(workflow).toContain('needs: [retry-policy, checks, e2e]');
    });

    it('overlaps synthetic-merge checks with exact-head E2E without weakening either tree', () => {
        const checksJob = workflow.match(/\n {2}checks:\n([\s\S]*?)\n {2}e2e:/u)?.[1];
        const e2eJob = workflow.match(/\n {2}e2e:\n([\s\S]*?)\n {2}ci:/u)?.[1];
        const concurrentIndex = e2eJob?.indexOf(
            'Execute synthetic-merge checks and exact-head E2E concurrently',
        );
        const checksReceiptIndex = e2eJob?.indexOf('Verify full platform checks');
        const parallelReceiptIndex = e2eJob?.indexOf(
            'run: bun run scripts/ci-concurrent-validation.ts verify parallel-safe',
        );
        const desktopReceiptIndex = e2eJob?.indexOf(
            'run: bun run scripts/ci-concurrent-validation.ts verify desktop-exclusive',
        );

        expect(checksJob).toContain("needs.retry-policy.outputs.e2e_profile != 'optimized'");
        expect(e2eJob).toContain('ref: ${{ github.event.pull_request.head.sha || github.sha }}');
        expect(e2eJob).toContain('CAXRI_CHECKS_REVISION: ${{ github.sha }}');
        expect(e2eJob).toContain("format('refs/pull/{0}/merge', github.event.pull_request.number)");
        expect(e2eJob).toContain('&& github.event.pull_request.base.sha');
        expect(e2eJob).toContain('CAXRI_CHECKS_HEAD_REVISION:');
        expect(e2eJob).toContain('CAXRI_CHECKS_REQUIRE_MERGE:');
        expect(e2eJob).toContain('CAXRI_GITHUB_TOKEN: ${{ github.token }}');
        expect(e2eJob).toContain('run: bun run scripts/ci-checks-worktree.ts create');
        expect(e2eJob).toContain('run: bun run scripts/ci-checks-worktree.ts remove');
        expect(e2eJob).toContain('run: bun run scripts/ci-concurrent-validation.ts run');
        expect(concurrentIndex).toBeGreaterThan(0);
        expect(checksReceiptIndex).toBeGreaterThan(concurrentIndex ?? 0);
        expect(parallelReceiptIndex).toBeGreaterThan(checksReceiptIndex ?? 0);
        expect(desktopReceiptIndex).toBeGreaterThan(parallelReceiptIndex ?? 0);
        expect(checksWorktree).toContain(
            "['clone', '--shared', '--no-checkout', projectRoot, path]",
        );
        expect(checksWorktree).toContain(
            "['fetch', '--no-tags', '--depth=1', 'origin', fetchReference]",
        );
        expect(checksWorktree).toContain('Synthetic merge parents do not match');
        expect(checksWorktree).toContain('CAXRI_REACT_DOCTOR_BASE=${baseRevision}');
        expect(checksWorktree).toContain('env: sanitizedChildEnvironment(process.env)');
        expect(concurrentValidation).toContain('await Promise.all([checksPromise, runE2E()])');
        for (const gate of [
            "'lint'",
            "'lint:type-aware'",
            "'lint:markdown'",
            "'knip'",
            "'doctor:changed'",
            "'typecheck'",
            "'format:check'",
            "'test'",
            "'scripts/ci-bundle-budget.ts'",
        ]) {
            expect(platformChecks, gate).toContain(gate);
        }
        expect(workflow).toContain(
            'FULL_CHECKS_RESULT: ${{ needs.e2e.outputs.full_checks_result }}',
        );
        expect(workflow).toContain('test "$FULL_CHECKS_RESULT" = success');
    });

    it('routes every job to the repository self-hosted runner without a hosted fallback', () => {
        const retryPolicyJob = workflow.match(/\n {2}retry-policy:\n([\s\S]*?)\n {2}checks:/u)?.[1];
        const checksJob = workflow.match(/\n {2}checks:\n([\s\S]*?)\n {2}e2e:/u)?.[1];
        const e2eJob = workflow.match(/\n {2}e2e:\n([\s\S]*?)\n {2}ci:/u)?.[1];
        const gateJob = workflow.match(/\n {2}ci:\n([\s\S]*)$/u)?.[1];

        expect(retryPolicyJob).toContain('runs-on: [self-hosted, macOS, ARM64, caxri-ci]');
        expect(checksJob).toContain('runs-on: [self-hosted, macOS, ARM64, caxri-ci]');
        expect(e2eJob).toContain('runs-on: [self-hosted, macOS, ARM64, caxri-e2e]');
        expect(gateJob).toContain('runs-on: [self-hosted, macOS, ARM64, caxri-ci]');
        expect(workflow).not.toContain('ubuntu-latest');
        expect(workflow).not.toContain('macos-latest');
        expect(workflow).not.toContain('github-hosted');
    });

    it('executes repository source only after the shared trusted-owner gate', () => {
        const retryPolicyJob = workflow.match(/\n {2}retry-policy:\n([\s\S]*?)\n {2}checks:/u)?.[1];
        const e2eJob = workflow.match(/\n {2}e2e:\n([\s\S]*?)\n {2}ci:/u)?.[1];
        const gateJob = workflow.match(/\n {2}ci:\n([\s\S]*)$/u)?.[1];

        expect(retryPolicyJob).toContain('uses: ./.github/actions/verify-trust-boundary');
        expect(e2eJob).toContain("needs.retry-policy.result == 'success'");
        expect(e2eJob).toContain('uses: ./.github/actions/verify-trust-boundary');
        expect(e2eJob).toContain("'trusted owner main push'");
        expect(e2eJob).toContain('persist-credentials: false');
        expect(gateJob).toContain('test "$TRUSTED_EVENT" = true');
        expect(gateJob).not.toContain('actions/checkout');
    });

    it('prepares and cleans every job that executes repository source', () => {
        const checksJob = workflow.match(/\n {2}checks:\n([\s\S]*?)\n {2}e2e:/u)?.[1];
        const e2eJob = workflow.match(/\n {2}e2e:\n([\s\S]*?)\n {2}ci:/u)?.[1];

        expect(setupAction).toContain('bun run scripts/self-hosted-runner.ts prepare');
        expect(workflow.match(/bun run scripts\/self-hosted-runner\.ts cleanup/gu)).toHaveLength(3);
        expect(workflow.match(/persist-credentials: false/gu)).toHaveLength(3);
        expect(workflow).toContain('CAXRI_RUNNER_OWNER:');
        expect(workflow.match(/CAXRI_RUNNER_AGENT_DISCOVERY: blocked/gu)).toHaveLength(3);
        expect(checksJob).not.toContain('CAXRI_E2E_AGENT_MODE');
        expect(e2eJob).toContain('CAXRI_E2E_AGENT_MODE: blocked');
        expect(
            workflow.match(/name: Clean self-hosted runner boundary\n {8}if: always\(\)/gu),
        ).toHaveLength(3);
        expect(e2eJob).toContain('bun run scripts/report-e2e-manifest.ts');
    });
});
