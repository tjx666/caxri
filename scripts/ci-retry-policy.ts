import type { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import process from 'node:process';

import { isExactReleasePreparationDelta } from '../.agents/skills/release/scripts/release-sources';
import type {
    CIExecutionPlan,
    CIExecutionPlanInput,
    CIReusableGreenRun,
} from './ci-execution-plan';
import { evaluateCIExecutionPlan } from './ci-execution-plan';
import type { GreenRunEvidence } from './ci-green-reuse';
import { evaluateGreenReusePolicy } from './ci-green-reuse';
import {
    isFullValidationPath,
    isProtectedRetryPath,
    ordinaryE2ESpecPattern,
    parsePullRequestE2ETests,
    selectAffectedE2ETests,
} from './ci-path-policy';

export interface RetryHint {
    baseRunId: number;
    e2eTests?: string[];
    mode: 'e2e-only' | 'e2e-repair';
}

export interface BaseRunEvidence {
    baseSha?: string;
    checksConclusion?: string;
    e2eConclusion?: string;
    e2eFailurePool?: 'control' | 'desktop-exclusive' | 'parallel-safe';
    event: string;
    headSha: string;
    pullRequestNumber?: number;
    repository: string;
    workflowPath?: string;
}

interface WorkflowJobRecord {
    conclusion?: string;
    name?: string;
    steps?: Array<{ conclusion?: string; name?: string }>;
}

interface WorkflowRunRecord {
    conclusion?: string;
    event?: string;
    head_sha?: string;
    id?: number;
    path?: string;
    pull_requests?: Array<{ base?: { sha?: string }; number?: number }>;
    repository?: { full_name?: string };
}

interface GreenReuseResolution extends CIReusableGreenRun {
    reason: string;
}

/**
 * The workflow contract pins this step as the receipt that the concurrent E2E job completed every full platform gate
 * against the synthetic merge commit.
 */
const fullChecksReceiptStep = 'Verify full platform checks';
const e2eAuxiliaryReceiptStep = 'Verify E2E auxiliary contracts';

export interface RetryPolicyInput {
    addedOrDeletedFiles: string[];
    baseRunChangedFiles: string[];
    baseRun?: BaseRunEvidence;
    baseRunTree?: string;
    changedFiles: string[];
    currentTree: string;
    eventName: string;
    hint?: RetryHint;
    hintError?: string;
    isAncestor: boolean;
    pullRequestBaseSha?: string;
    pullRequestNumber?: number;
    repository: string;
    workflowPath: string;
}

export interface RetryPolicyDecision {
    baseRunId?: number;
    e2ePool?: 'control' | 'desktop-exclusive' | 'parallel-safe';
    e2eTests?: string[];
    mode: 'e2e-only' | 'e2e-repair' | 'full';
    reason: string;
    retryKind?: 'metadata-only' | 'spec-only';
}

export function retryDiffArguments(ancestor: string, current: string): string[] {
    return ['diff', '--no-renames', '--name-only', '-z', `${ancestor}...${current}`];
}

export function retryAddedOrDeletedDiffArguments(ancestor: string, current: string): string[] {
    return [
        'diff',
        '--no-renames',
        '--diff-filter=AD',
        '--name-only',
        '-z',
        `${ancestor}...${current}`,
    ];
}

/**
 * Aggregates legacy, split-matrix, and single-machine logical-pool E2E evidence without hiding failures.
 */
const poolStepNames = {
    'control': 'Run one-worker control suite',
    'desktop-exclusive': 'Run desktop-exclusive pool',
    'parallel-safe': 'Run parallel-safe pool',
} as const;

function poolFromStep(step: {
    conclusion?: string;
    name?: string;
}): 'control' | 'desktop-exclusive' | 'parallel-safe' | undefined {
    return (Object.entries(poolStepNames).find(([, name]) => name === step.name)?.[0] ??
        undefined) as 'control' | 'desktop-exclusive' | 'parallel-safe' | undefined;
}

export function summarizeE2EJobs(
    jobs: WorkflowJobRecord[] | undefined,
): Pick<BaseRunEvidence, 'e2eConclusion' | 'e2eFailurePool'> {
    const e2eJobs = jobs?.filter(({ name }) => name === 'e2e' || name?.startsWith('e2e / ')) ?? [];
    if (
        e2eJobs.length === 0 ||
        e2eJobs.some(({ conclusion }) => conclusion !== 'success' && conclusion !== 'failure')
    ) {
        return {};
    }
    const failed = e2eJobs.filter(({ conclusion }) => conclusion === 'failure');
    if (failed.length === 0) return { e2eConclusion: 'success' };
    if (failed.length > 1) return { e2eConclusion: 'failure' };

    const e2eFailurePools = ['control', 'desktop-exclusive', 'parallel-safe'] as const;
    const [failedJob] = failed;
    const steps = failedJob.steps ?? [];
    if (
        steps.some(
            ({ conclusion }) =>
                conclusion !== 'success' && conclusion !== 'failure' && conclusion !== 'skipped',
        )
    ) {
        return { e2eConclusion: 'failure' };
    }
    const failedSteps = steps.filter((step) => step.conclusion === 'failure');
    let onlyFailedPool: string | undefined;
    if (failedJob.name !== 'e2e') {
        const jobPool = failedJob.name?.slice('e2e / '.length);
        const failedStepPool = failedSteps.length === 1 ? poolFromStep(failedSteps[0]) : undefined;
        if (failedStepPool === jobPool) onlyFailedPool = jobPool;
    } else if (failedSteps.length === 1) {
        onlyFailedPool = poolFromStep(failedSteps[0]);
        if (
            onlyFailedPool !== 'control' &&
            (steps.find(({ name }) => name === e2eAuxiliaryReceiptStep)?.conclusion !== 'success' ||
                (['parallel-safe', 'desktop-exclusive'] as const).some((pool) =>
                    steps.every(
                        (step) =>
                            !(
                                poolFromStep(step) === pool &&
                                (step.conclusion === 'success' || step.conclusion === 'failure')
                            ),
                    ),
                ))
        ) {
            onlyFailedPool = undefined;
        }
    }
    const e2eFailurePool =
        onlyFailedPool !== undefined &&
        // `Array#includes` narrows its argument to the tuple's element type; widen the array's
        // type for the check instead of casting `onlyFailedPool` away from `string | undefined`.
        (e2eFailurePools as readonly string[]).includes(onlyFailedPool)
            ? (onlyFailedPool as (typeof e2eFailurePools)[number])
            : undefined;
    return {
        e2eConclusion: 'failure',
        e2eFailurePool,
    };
}

function oneTrailer(message: string, name: string): string | undefined {
    const values = message.split(/\r?\n/u).flatMap((line) => {
        const match = new RegExp(String.raw`^${name}:\s*(.+)$`, 'u').exec(line);
        return match?.[1] ? [match[1].trim()] : [];
    });
    if (values.length > 1) throw new Error(`duplicate ${name} trailer`);
    return values[0];
}

export function parseRetryHint(message: string): { error?: string; hint?: RetryHint } {
    try {
        const mode = oneTrailer(message, 'CI-Mode');
        const baseRun = oneTrailer(message, 'CI-Base-Run');
        const e2eTests = oneTrailer(message, 'CI-E2E-Tests');
        if (!mode && !baseRun && !e2eTests) return {};
        if (mode !== 'e2e-only' && mode !== 'e2e-repair') {
            return { error: 'CI-Mode must be e2e-only or e2e-repair' };
        }
        if (!baseRun || !/^\d+$/u.test(baseRun)) return { error: 'CI-Base-Run must be numeric' };
        let parsedEndToEndTests: string[] | undefined;
        if (e2eTests) {
            const value: unknown = JSON.parse(e2eTests);
            if (Array.isArray(value) && value.includes('e2e/renderer.performance.e2e.ts')) {
                return {
                    error: 'Renderer performance requires the profiling CI gate, not e2e-repair',
                };
            }
            if (
                !Array.isArray(value) ||
                value.length === 0 ||
                value.some(
                    (path) =>
                        typeof path !== 'string' ||
                        !/^e2e\/[a-z0-9][a-z0-9-]*\.e2e\.ts$/u.test(path),
                )
            ) {
                return { error: 'CI-E2E-Tests must be a non-empty JSON array of E2E spec paths' };
            }
            parsedEndToEndTests = [...new Set(value)];
        }
        if (mode === 'e2e-only' && parsedEndToEndTests) {
            return { error: 'CI-E2E-Tests is only valid for e2e-repair' };
        }
        return {
            hint: {
                baseRunId: Number(baseRun),
                e2eTests: parsedEndToEndTests,
                mode,
            },
        };
    } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
    }
}

export function evaluateRetryPolicy(input: RetryPolicyInput): RetryPolicyDecision {
    if (!input.hint && !input.hintError) return { mode: 'full', reason: 'no retry trailers' };
    if (input.hintError) return { mode: 'full', reason: `invalid retry hint: ${input.hintError}` };
    const hint = input.hint!;
    const full = (reason: string): RetryPolicyDecision => ({
        baseRunId: hint.baseRunId,
        mode: 'full',
        reason,
    });
    if (input.eventName !== 'pull_request') return full('retry hints are pull-request only');
    if (!input.pullRequestNumber || !input.pullRequestBaseSha) {
        return full('current pull-request identity is unavailable');
    }
    const base = input.baseRun;
    if (!base) return full('base run could not be verified');
    if (base.repository !== input.repository || base.event !== 'pull_request') {
        return full('base run belongs to a different repository or event');
    }
    if (base.workflowPath !== input.workflowPath) return full('base run uses a different workflow');
    if (base.pullRequestNumber !== input.pullRequestNumber) {
        return full('base run belongs to a different pull request');
    }
    if (base.baseSha !== input.pullRequestBaseSha) return full('pull-request base SHA changed');
    if (base.checksConclusion !== 'success' || base.e2eConclusion !== 'failure') {
        return full('base run must have successful checks and failed e2e');
    }
    if (!input.isAncestor) return full('base run head is not an ancestor of the current head');
    const protectedFile = input.changedFiles.find(isProtectedRetryPath);
    if (protectedFile) return full(`protected configuration changed: ${protectedFile}`);
    const protectedBaseRunFile = input.baseRunChangedFiles.find(isProtectedRetryPath);
    if (protectedBaseRunFile) {
        return full(`base run includes protected configuration: ${protectedBaseRunFile}`);
    }
    if (!base.e2eFailurePool) return full('base E2E failure did not isolate one logical pool');
    if (hint.mode === 'e2e-only') {
        if (input.changedFiles.length > 0 || input.baseRunTree !== input.currentTree) {
            return full('e2e-only requires the base run tree to remain unchanged');
        }
        return {
            baseRunId: hint.baseRunId,
            e2ePool: base.e2eFailurePool,
            mode: hint.mode,
            reason: 'validated metadata-only retry is eligible',
            retryKind: 'metadata-only',
        };
    }
    if (input.changedFiles.length === 0) return full('e2e-repair requires a changed E2E spec');
    if (input.addedOrDeletedFiles.length > 0) {
        return full(
            `E2E spec additions and deletions require full CI: ${input.addedOrDeletedFiles[0]}`,
        );
    }
    const nonSpecFile = input.changedFiles.find((path) => !ordinaryE2ESpecPattern.test(path));
    if (nonSpecFile) return full(`retry delta is not E2E spec-only: ${nonSpecFile}`);
    const protectedNamedSpec = hint.e2eTests?.find(isProtectedRetryPath);
    if (protectedNamedSpec) {
        return full(`focused repair includes a protected spec: ${protectedNamedSpec}`);
    }
    const e2eTests = [...new Set([...input.changedFiles, ...(hint.e2eTests ?? [])])];
    return {
        baseRunId: hint.baseRunId,
        e2ePool: base.e2eFailurePool,
        e2eTests,
        mode: hint.mode,
        reason: 'validated E2E spec-only repair is eligible',
        retryKind: 'spec-only',
    };
}

async function capture(command: string, arguments_: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, arguments_, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
        child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
        child.on('error', reject);
        child.on('close', (code) =>
            code === 0
                ? resolve(stdout.trim())
                : reject(new Error(`${command} exited ${String(code)}: ${stderr.trim()}`)),
        );
    });
}

function nullSeparatedPaths(value: string): string[] {
    return value.split('\0').filter(Boolean);
}

export function greenReuseDiffArguments(ancestor: string, current: string): string[] {
    return retryDiffArguments(ancestor, current);
}

async function githubJson(path: string): Promise<unknown> {
    const api = process.env.GITHUB_API_URL ?? 'https://api.github.com';
    const response = await fetch(`${api}${path}`, {
        headers: {
            'Accept': 'application/vnd.github+json',
            'Authorization': `Bearer ${process.env.GITHUB_TOKEN ?? ''}`,
            'X-GitHub-Api-Version': '2022-11-28',
        },
    });
    if (!response.ok) throw new Error(`GitHub API ${path} returned ${response.status}`);
    return response.json();
}

export function extractBaseRunIdentity(
    pullRequests: Array<{ base?: { sha?: string }; number?: number }> | undefined,
    jobs: Array<{ name?: string }> | undefined,
): { baseSha?: string; pullRequestNumber?: number } {
    const pullRequest = pullRequests?.[0];
    if (pullRequest?.number && pullRequest.base?.sha) {
        return { baseSha: pullRequest.base.sha, pullRequestNumber: pullRequest.number };
    }
    const receipt = jobs
        ?.map(({ name }) => /^retry-policy \/ pr-(\d+) \/ base-([0-9a-f]{40})$/u.exec(name ?? ''))
        .find((match) => match !== null);
    return receipt ? { baseSha: receipt[2], pullRequestNumber: Number(receipt[1]) } : {};
}

export function extractGreenRunEvidence(
    run: WorkflowRunRecord,
    jobs: WorkflowJobRecord[],
): GreenRunEvidence {
    const identity = extractBaseRunIdentity(run.pull_requests, jobs);
    const checksEvidence = resolveChecksEvidence(jobs);
    const e2e = summarizeE2EJobs(jobs);
    return {
        baseSha: identity.baseSha,
        checksConclusion: checksEvidence.checksConclusion,
        e2eConclusion: e2e.e2eConclusion,
        event: run.event ?? '',
        fullChecksConclusion: checksEvidence.fullChecksConclusion,
        gateConclusion: jobs.find(({ name }) => name === 'CI gate')?.conclusion,
        headSha: run.head_sha ?? '',
        id: run.id ?? 0,
        pullRequestNumber: identity.pullRequestNumber,
        repository: run.repository?.full_name ?? '',
        runConclusion: run.conclusion,
        workflowPath: run.path,
    };
}

function resolveChecksEvidence(jobs: WorkflowJobRecord[] | undefined): {
    checksConclusion?: string;
    fullChecksConclusion?: string;
} {
    const checks = jobs?.find(({ name }) => name === 'checks');
    if (checks?.conclusion && checks.conclusion !== 'skipped') {
        return {
            checksConclusion: checks.conclusion,
            fullChecksConclusion: checks.steps?.find(
                ({ name }) => name === 'Run full platform checks',
            )?.conclusion,
        };
    }
    const concurrentChecks = jobs
        ?.find(({ name }) => name === 'e2e')
        ?.steps?.find(({ name }) => name === fullChecksReceiptStep);
    return {
        checksConclusion: concurrentChecks?.conclusion,
        fullChecksConclusion: concurrentChecks?.conclusion,
    };
}

async function loadBaseRun(repo: string, runId: number): Promise<BaseRunEvidence> {
    const [runValue, jobsValue] = await Promise.all([
        githubJson(`/repos/${repo}/actions/runs/${runId}`),
        githubJson(`/repos/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`),
    ]);
    const run = runValue as {
        event?: string;
        head_sha?: string;
        pull_requests?: Array<{ base?: { sha?: string }; number?: number }>;
        repository?: { full_name?: string };
        path?: string;
    };
    const jobs = jobsValue as { jobs?: WorkflowJobRecord[] };
    const identity = extractBaseRunIdentity(run.pull_requests, jobs.jobs);
    const e2e = summarizeE2EJobs(jobs.jobs);
    const checksEvidence = resolveChecksEvidence(jobs.jobs);
    return {
        baseSha: identity.baseSha,
        checksConclusion: checksEvidence.checksConclusion,
        ...e2e,
        event: run.event ?? '',
        headSha: run.head_sha ?? '',
        pullRequestNumber: identity.pullRequestNumber,
        repository: run.repository?.full_name ?? '',
        workflowPath: run.path,
    };
}

/**
 * Searches only the latest successful runs on the current PR branch. Missing API, lineage, job, or path evidence
 * returns no receipt so the caller keeps full Linux and macOS coverage.
 */
async function findReusableGreenRun(input: {
    currentHeadSha: string;
    eventName: string;
    headRef: string;
    pullRequestBaseSha: string;
    pullRequestNumber: number;
    repository: string;
    workflowPath: string;
}): Promise<{ reason: string; reusableGreenRun?: GreenReuseResolution }> {
    const workflowId = encodeURIComponent(input.workflowPath.split('/').at(-1) ?? '');
    const query = new URLSearchParams({
        branch: input.headRef,
        event: 'pull_request',
        per_page: '20',
        status: 'success',
    });
    const value = (await githubJson(
        `/repos/${input.repository}/actions/workflows/${workflowId}/runs?${query.toString()}`,
    )) as { workflow_runs?: WorkflowRunRecord[] };
    const runs = value.workflow_runs ?? [];
    let lastReason = 'no successful workflow run exists on the pull-request branch';

    for (const run of runs) {
        if (!run.id || run.head_sha === input.currentHeadSha) continue;
        let changedFiles: string[];
        try {
            // Runs are checked oldest-evidence-first and the first eligible run wins, so each
            // candidate must be verified in order rather than concurrently.
            // eslint-disable-next-line no-await-in-loop -- ordered search must stop at the first eligible run
            await capture('git', [
                'merge-base',
                '--is-ancestor',
                run.head_sha ?? '',
                input.currentHeadSha,
            ]);
            changedFiles = nullSeparatedPaths(
                // eslint-disable-next-line no-await-in-loop -- ordered search must stop at the first eligible run
                await capture(
                    'git',
                    greenReuseDiffArguments(run.head_sha ?? '', input.currentHeadSha),
                ),
            );
        } catch {
            lastReason = `run ${run.id} is not an available ancestor of the current head`;
            continue;
        }
        // eslint-disable-next-line no-await-in-loop -- ordered search must stop at the first eligible run
        const jobsValue = (await githubJson(
            `/repos/${input.repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`,
        )) as { jobs?: WorkflowJobRecord[] };
        const candidate = extractGreenRunEvidence(run, jobsValue.jobs ?? []);
        const decision = evaluateGreenReusePolicy({
            candidate,
            changedFiles,
            currentHeadSha: input.currentHeadSha,
            eventName: input.eventName,
            isAncestor: true,
            pullRequestBaseSha: input.pullRequestBaseSha,
            pullRequestNumber: input.pullRequestNumber,
            repository: input.repository,
            workflowPath: input.workflowPath,
        });
        if (decision.eligible) {
            return {
                reason: decision.reason,
                reusableGreenRun: {
                    changedFiles,
                    headSha: candidate.headSha,
                    reason: decision.reason,
                    runId: candidate.id,
                },
            };
        }
        lastReason = decision.reason;
    }

    return { reason: lastReason };
}

async function writeDecision(
    decision: RetryPolicyDecision,
    execution: CIExecutionPlan,
    allChangedFiles: readonly string[],
    executionChangedFiles: readonly string[],
    greenReuse: { reason: string; reusableGreenRun?: GreenReuseResolution },
): Promise<void> {
    const output = process.env.GITHUB_OUTPUT;
    const summary = process.env.GITHUB_STEP_SUMMARY;
    const reason = decision.reason.replaceAll(/[\r\n]+/gu, ' ');
    if (output) {
        await appendFile(
            output,
            `${[
                `mode=${decision.mode}`,
                `reason=${reason}`,
                `base_run=${decision.baseRunId ?? ''}`,
                `retry_kind=${decision.retryKind ?? ''}`,
                `e2e_tests=${JSON.stringify(execution.e2eTests ?? decision.e2eTests ?? [])}`,
                `e2e_pool=${decision.e2ePool ?? 'control'}`,
                `checks_scope=${execution.checksScope}`,
                `run_e2e=${String(execution.runE2E)}`,
                `e2e_profile=${execution.e2eProfile}`,
                `changed_files=${JSON.stringify(executionChangedFiles)}`,
                `reused_e2e_run=${greenReuse.reusableGreenRun?.runId ?? ''}`,
                `reused_e2e_head=${greenReuse.reusableGreenRun?.headSha ?? ''}`,
            ].join('\n')}\n`,
        );
    }
    if (summary) {
        await appendFile(
            summary,
            `## CI execution plan\n\n- Mode: \`${decision.mode}\`\n- Retry kind: \`${decision.retryKind ?? 'none'}\`\n- Retry reason: ${reason}\n- Checks: \`${execution.checksScope}\`\n- E2E: ${execution.runE2E ? `\`${execution.e2eProfile}\`` : 'skipped'}\n- Plan reason: ${execution.reason}\n- Base run: ${decision.baseRunId ?? 'none'}\n- Focused E2E: ${(execution.e2eTests ?? decision.e2eTests)?.map((path) => `\`${path}\``).join(', ') ?? 'none'}\n- Failed E2E pool: \`${decision.e2ePool ?? 'control'}\`\n- Reused E2E run: ${greenReuse.reusableGreenRun?.runId ?? 'none'}\n- Reused E2E head: \`${greenReuse.reusableGreenRun?.headSha ?? 'none'}\`\n- Green reuse: ${greenReuse.reason.replaceAll(/[\r\n]+/gu, ' ')}\n- Pull-request changed files: ${allChangedFiles.length}\n- Current checks changed files: ${executionChangedFiles.length}\n`,
        );
    }
    process.stdout.write(`${JSON.stringify(decision)}\n`);
}

async function main(): Promise<void> {
    const eventPath = process.env.GITHUB_EVENT_PATH;
    const repo = process.env.GITHUB_REPOSITORY ?? '';
    if (!eventPath || !repo) throw new Error('GitHub Actions environment is required');
    const event = JSON.parse(await readFile(eventPath, 'utf8')) as {
        before?: string;
        inputs?: { e2e_profile?: 'control' | 'optimized' | 'skip' };
        pull_request?: {
            base?: { sha?: string };
            body?: string | null;
            draft?: boolean;
            head?: { ref?: string };
            number?: number;
        };
    };
    const [commitMessage, commitSubject, packageManifest, currentHeadSha, currentTree] =
        await Promise.all([
            capture('git', ['log', '-1', '--format=%B']),
            capture('git', ['log', '-1', '--format=%s']),
            readFile(new URL('../package.json', import.meta.url), 'utf8'),
            capture('git', ['rev-parse', 'HEAD']),
            capture('git', ['rev-parse', 'HEAD^{tree}']),
        ]);
    const parsed = parseRetryHint(commitMessage);
    const comparisonBase =
        event.pull_request?.base?.sha ??
        (event.before && !/^0{40}$/u.test(event.before) ? event.before : undefined);
    const allChangedFiles = comparisonBase
        ? nullSeparatedPaths(await capture('git', retryDiffArguments(comparisonBase, 'HEAD')))
        : [];
    let baseRun: BaseRunEvidence | undefined;
    let isAncestor = false;
    let baseRunTree: string | undefined;
    let retryChangedFiles: string[] = [];
    let retryAddedOrDeletedFiles: string[] = [];
    let baseRunChangedFiles: string[] = [];
    if (parsed.hint) {
        try {
            baseRun = await loadBaseRun(repo, parsed.hint.baseRunId);
            await capture('git', ['merge-base', '--is-ancestor', baseRun.headSha, 'HEAD']);
            isAncestor = true;
            baseRunTree = await capture('git', [
                'rev-parse',
                [baseRun.headSha, '^{tree}'].join(''),
            ]);
            retryChangedFiles = nullSeparatedPaths(
                await capture('git', retryDiffArguments(baseRun.headSha, 'HEAD')),
            );
            retryAddedOrDeletedFiles = nullSeparatedPaths(
                await capture('git', retryAddedOrDeletedDiffArguments(baseRun.headSha, 'HEAD')),
            );
            baseRunChangedFiles = nullSeparatedPaths(
                await capture(
                    'git',
                    retryDiffArguments(event.pull_request?.base?.sha ?? '', baseRun.headSha),
                ),
            );
        } catch (error) {
            parsed.error = `verification failed: ${error instanceof Error ? error.message : String(error)}`;
        }
    }
    const retryDecision = evaluateRetryPolicy({
        addedOrDeletedFiles: retryAddedOrDeletedFiles,
        baseRun,
        baseRunChangedFiles,
        baseRunTree,
        changedFiles: retryChangedFiles,
        currentTree,
        eventName: process.env.GITHUB_EVENT_NAME ?? '',
        hint: parsed.hint,
        hintError: parsed.error,
        isAncestor,
        pullRequestBaseSha: event.pull_request?.base?.sha,
        pullRequestNumber: event.pull_request?.number,
        repository: repo,
        workflowPath: '.github/workflows/ci.yml',
    });
    const packageVersion = (JSON.parse(packageManifest) as { version?: string }).version;
    const hasReleaseIdentity =
        typeof packageVersion === 'string' && commitSubject === `release: v${packageVersion}`;
    const isVerifiedReleaseCommit =
        hasReleaseIdentity &&
        (await isExactReleasePreparationDelta(process.cwd(), allChangedFiles));
    const eventName = process.env.GITHUB_EVENT_NAME ?? '';
    let affectedE2ETests: string[] = [];
    let affectedSelectionError: string | undefined;
    if (eventName === 'pull_request') {
        try {
            const existingSpecs = new Set(
                nullSeparatedPaths(await capture('git', ['ls-files', '-z', '--', 'e2e/*.e2e.ts'])),
            );
            affectedE2ETests = selectAffectedE2ETests({
                changedFiles: allChangedFiles,
                declared: parsePullRequestE2ETests(event.pull_request?.body ?? undefined),
                existingSpecs,
                related: [],
            });
        } catch (error) {
            affectedSelectionError = error instanceof Error ? error.message : String(error);
        }
    }
    const executionInput: CIExecutionPlanInput = {
        affectedE2ETests,
        affectedSelectionError,
        changedFiles: allChangedFiles,
        dispatchE2EProfile: event.inputs?.e2e_profile,
        eventName,
        hasFullValidationPath: allChangedFiles.some(isFullValidationPath),
        isVerifiedReleaseCommit,
        pullRequestDraft: event.pull_request?.draft,
        retryMode: retryDecision.mode === 'full' ? undefined : retryDecision.mode,
        retryKind: retryDecision.retryKind,
    };
    const initialExecution = evaluateCIExecutionPlan(executionInput);
    let greenReuse: { reason: string; reusableGreenRun?: GreenReuseResolution } = {
        reason: 'not evaluated for this execution path',
    };
    if (
        retryDecision.mode === 'full' &&
        !parsed.hint &&
        !parsed.error &&
        initialExecution.runE2E &&
        event.pull_request?.base?.sha &&
        event.pull_request.head?.ref &&
        event.pull_request.number
    ) {
        try {
            greenReuse = await findReusableGreenRun({
                currentHeadSha,
                eventName: process.env.GITHUB_EVENT_NAME ?? '',
                headRef: event.pull_request.head.ref,
                pullRequestBaseSha: event.pull_request.base.sha,
                pullRequestNumber: event.pull_request.number,
                repository: repo,
                workflowPath: '.github/workflows/ci.yml',
            });
        } catch (error) {
            greenReuse = {
                reason: `verification failed closed: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
    }
    const execution = evaluateCIExecutionPlan({
        ...executionInput,
        reusableGreenRun: greenReuse.reusableGreenRun,
    });
    await writeDecision(
        retryDecision,
        execution,
        allChangedFiles,
        greenReuse.reusableGreenRun?.changedFiles ??
            (retryDecision.mode === 'full' ? allChangedFiles : retryChangedFiles),
        greenReuse,
    );
}

if (import.meta.main) {
    try {
        await main();
    } catch (error) {
        const reason = `policy evaluation failed closed: ${error instanceof Error ? error.message : String(error)}`;
        await writeDecision(
            { mode: 'full', reason },
            {
                checksScope: 'full',
                e2eProfile: 'control',
                reason,
                runE2E: true,
            },
            [],
            [],
            { reason },
        );
    }
}
