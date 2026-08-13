import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { mkdir, mkdtemp, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const execFile = promisify(execFileCallback);

const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const setupAction = await readFile(
    new URL('../.github/actions/setup-caxri-job/action.yml', import.meta.url),
    'utf8',
);
const bunVersion = (await readFile(new URL('../.bun-version', import.meta.url), 'utf8')).trim();
const packageManifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
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
        expect(setupAction).toContain('uses: actions/setup-node@v7');
        expect(setupAction).toContain('package-manager-cache: false');
        expect(setupAction).toContain(
            'bun_directory="$RUNNER_TOOL_CACHE/caxri/bun/$bun_version/bin"',
        );
        expect(setupAction).not.toContain('oven-sh/setup-bun');
        expect(setupAction).toContain('cache_root="$RUNNER_TOOL_CACHE/caxri"');
        expect(setupAction).toContain(
            'npm ci --ignore-scripts --prefer-offline --no-audit --no-fund',
        );
        expect(setupAction).toContain('npm rebuild electron');
        expect(setupAction).toContain('bun run rebuild');
        expect(bunVersion).toBe('1.3.14');
        expect(workflow).toContain('Electron native compatibility');
        expect(workflow).toContain('bun run spike:native');
        expect(workflow).toContain('--label "Vitest full suite" -- bun run test');
        expect(workflow.match(/--label "Electron Vite build" -- bun run build/gu)).toHaveLength(2);
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
        const persistentCache = join(toolCache, 'caxri', 'prettier');
        const githubEnv = join(root, 'github-env');
        const githubSummary = join(root, 'github-summary');

        try {
            expect(cacheStep?.run).toBeTruthy();
            await mkdir(workspace, { recursive: true });
            await mkdir(join(toolCache, 'caxri'), { recursive: true });
            await writeFile(persistentCache, '');
            await writeFile(githubEnv, '');
            await writeFile(githubSummary, '');

            await execFile('bash', ['-e', '-o', 'pipefail', '-c', cacheStep?.run ?? 'exit 1'], {
                cwd: workspace,
                env: {
                    ...process.env,
                    GITHUB_ENV: githubEnv,
                    GITHUB_STEP_SUMMARY: githubSummary,
                    RUNNER_TOOL_CACHE: toolCache,
                },
            });

            expect(await readlink(join(workspace, '.cache', 'prettier'))).toBe(persistentCache);
            await writeFile(join(workspace, 'fixture.js'), 'const value = 1;\n');
            await execFile(
                fileURLToPath(new URL('../node_modules/.bin/prettier', import.meta.url)),
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
        const optimizedPoolIndex = workflow.indexOf('--pool parallel-safe');

        expect(interruptionIndex).toBeGreaterThan(0);
        expect(optimizedPoolIndex).toBeGreaterThan(interruptionIndex);
        expect(workflow).toContain('bun run scripts/run-e2e-failure-isolation.ts');
        expect(workflow).toContain('name: e2e / ${{ matrix.pool }}');
        expect(workflow).toContain(
            'needs.retry-policy.outputs.e2e_profile == \'optimized\' && \'["parallel-safe","desktop-exclusive"]\'',
        );
        expect(workflow).toContain('bun run scripts/run-e2e-pools.ts --pool parallel-safe');
        expect(workflow).toContain('bun run scripts/run-e2e-pools.ts --pool desktop-exclusive');
        expect(workflow).toContain('bunx playwright test --workers=1');
        expect(workflow).toContain(
            "if: github.event_name == 'workflow_dispatch' && (matrix.pool == 'control' || matrix.pool == 'desktop-exclusive')",
        );
        expect(workflow).toContain('bun run scripts/run-ci-parity.ts');
    });

    it('runs focused repair specs before the complete E2E suite and exposes one stable gate', () => {
        const e2eJob = workflow.match(/\n {2}e2e:\n([\s\S]*?)\n {2}ci:/u)?.[1];
        const focusedIndex = workflow.indexOf('run: bun run scripts/run-e2e-repair.ts');
        const fullIndex = workflow.indexOf('bunx playwright test --workers=1');

        expect(focusedIndex).toBeGreaterThan(0);
        expect(fullIndex).toBeGreaterThan(focusedIndex);
        expect(e2eJob).toContain('ref: ${{ github.event.pull_request.head.sha || github.sha }}');
        expect(workflow).toContain('name: CI gate');
        expect(workflow).toContain('needs: [retry-policy, checks, e2e]');
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

    it('executes repository source only for trusted owner events and fails other PRs closed', () => {
        const retryPolicyJob = workflow.match(/\n {2}retry-policy:\n([\s\S]*?)\n {2}checks:/u)?.[1];
        const e2eJob = workflow.match(/\n {2}e2e:\n([\s\S]*?)\n {2}ci:/u)?.[1];
        const gateJob = workflow.match(/\n {2}ci:\n([\s\S]*)$/u)?.[1];

        for (const job of [retryPolicyJob, e2eJob]) {
            expect(job).toContain("github.actor == 'tjx666'");
            expect(job).toContain("github.triggering_actor == 'tjx666'");
            expect(job).toContain("github.event.pull_request.user.login == 'tjx666'");
            expect(job).toContain(
                'github.event.pull_request.head.repo.full_name == github.repository',
            );
        }
        expect(e2eJob).toContain("github.ref == 'refs/heads/main'");
        expect(e2eJob).toContain("startsWith(github.event.head_commit.message, 'release: v')");
        expect(e2eJob).toContain("'trusted tjx666 release commit'");
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
