import { appendFile, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

import {
    evaluateCIExecutionPlan,
    type CIExecutionPlan,
    type CIExecutionPlanInput,
    type CIReusableGreenRun,
} from './ci-execution-plan';
import { evaluateGreenReusePolicy, type GreenRunEvidence } from './ci-green-reuse';

export interface RetryHint {
    baseRunId: number;
    e2eTests?: string[];
    mode: 'e2e-only' | 'e2e-repair';
    validatedTree: string;
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

/** The workflow contract pins this step as the receipt that the checks job used full scope. */
const fullChecksReceiptStep = 'Run ESLint';

export interface RetryPolicyInput {
    baseRunChangedFiles: string[];
    baseRun?: BaseRunEvidence;
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
    validatedTree?: string;
}

const protectedPathPatterns = [
    /^\.github\/workflows\//,
    /^(?:package|package-lock)\.json$/,
    /^(?:electron\.vite|eslint|knip|playwright|tsconfig|vite|vitest)(?:\.[^/]+)?$/,
    /^scripts\/(?:doctor-changed|native-spike)\.ts$/,
    /^scripts\/(?:ci-execution-plan|ci-green-reuse|ci-metrics|ci-retry-policy|report-e2e-manifest|run-ci-focused-checks|run-e2e-failure-isolation|run-e2e-pools|run-e2e-repair|run-hosted-parity|self-hosted-e2e-runner)\.ts$/,
    /^e2e\/(?:failure-isolation\.e2e|pools|worker-isolation)\.ts$/,
    /^\.agents\/skills\/(?:quality-check|switch-worktree)\//,
    /^\.agents\/skills\/e2e-testing\//,
    /^\.agents\/skills\/(?:build|release)\//,
    /^build\//,
    /^RELEASING\.md$/,
];

export function isProtectedRetryPath(path: string): boolean {
    return protectedPathPatterns.some((pattern) => pattern.test(path));
}

/** Aggregates both the legacy single E2E job and the split pool matrix without hiding failures. */
export function summarizeE2EJobs(
    jobs: Array<{ conclusion?: string; name?: string }> | undefined,
): Pick<BaseRunEvidence, 'e2eConclusion' | 'e2eFailurePool'> {
    const e2eJobs = jobs?.filter(({ name }) => name === 'e2e' || name?.startsWith('e2e / ')) ?? [];
    const failed = e2eJobs.filter(({ conclusion }) => conclusion === 'failure');
    const failedPools = [
        ...new Set(
            failed.map(({ name }) => (name === 'e2e' ? 'control' : name?.slice('e2e / '.length))),
        ),
    ];
    const e2eFailurePool =
        failedPools.length === 1 &&
        (failedPools[0] === 'control' ||
            failedPools[0] === 'desktop-exclusive' ||
            failedPools[0] === 'parallel-safe')
            ? failedPools[0]
            : undefined;
    return {
        e2eConclusion:
            failed.length > 0
                ? 'failure'
                : e2eJobs.length > 0 && e2eJobs.every(({ conclusion }) => conclusion === 'success')
                  ? 'success'
                  : undefined,
        e2eFailurePool,
    };
}

function oneTrailer(message: string, name: string): string | undefined {
    const values = message.split(/\r?\n/u).flatMap((line) => {
        const match = new RegExp(`^${name}:\\s*(.+)$`, 'u').exec(line);
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
        const validatedTree = oneTrailer(message, 'CI-Validated-Tree');
        if (!mode && !baseRun && !e2eTests && !validatedTree) return {};
        if (mode !== 'e2e-only' && mode !== 'e2e-repair') {
            return { error: 'CI-Mode must be e2e-only or e2e-repair' };
        }
        if (!baseRun || !/^\d+$/u.test(baseRun)) return { error: 'CI-Base-Run must be numeric' };
        if (!validatedTree || !/^[0-9a-f]{40}$/u.test(validatedTree)) {
            return { error: 'CI-Validated-Tree must be a full tree SHA' };
        }
        let parsedE2eTests: string[] | undefined;
        if (e2eTests) {
            const value: unknown = JSON.parse(e2eTests);
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
            parsedE2eTests = [...new Set(value)];
        }
        if (mode === 'e2e-repair' && !parsedE2eTests) {
            return { error: 'CI-E2E-Tests is required for e2e-repair' };
        }
        if (mode === 'e2e-only' && parsedE2eTests) {
            return { error: 'CI-E2E-Tests is only valid for e2e-repair' };
        }
        return {
            hint: { baseRunId: Number(baseRun), e2eTests: parsedE2eTests, mode, validatedTree },
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
        validatedTree: hint.validatedTree,
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
    if (hint.validatedTree !== input.currentTree) return full('validated tree does not match HEAD');
    const protectedFile = input.changedFiles.find(isProtectedRetryPath);
    if (protectedFile) return full(`protected configuration changed: ${protectedFile}`);
    const protectedBaseRunFile = input.baseRunChangedFiles.find(isProtectedRetryPath);
    if (protectedBaseRunFile) {
        return full(`base run includes protected configuration: ${protectedBaseRunFile}`);
    }
    return {
        baseRunId: hint.baseRunId,
        e2ePool: base.e2eFailurePool ?? 'control',
        e2eTests: hint.e2eTests,
        mode: hint.mode,
        reason: 'validated exact-tree retry is eligible',
        validatedTree: hint.validatedTree,
    };
}

async function capture(command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
    return ['diff', '--no-renames', '--name-only', '-z', `${ancestor}...${current}`];
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
    const checks = jobs.find(({ name }) => name === 'checks');
    const e2e = summarizeE2EJobs(jobs);
    return {
        baseSha: identity.baseSha,
        checksConclusion: checks?.conclusion,
        e2eConclusion: e2e.e2eConclusion,
        event: run.event ?? '',
        fullChecksConclusion: checks?.steps?.find(({ name }) => name === fullChecksReceiptStep)
            ?.conclusion,
        gateConclusion: jobs.find(({ name }) => name === 'CI gate')?.conclusion,
        headSha: run.head_sha ?? '',
        id: run.id ?? 0,
        pullRequestNumber: identity.pullRequestNumber,
        repository: run.repository?.full_name ?? '',
        runConclusion: run.conclusion,
        workflowPath: run.path,
    };
}

async function loadBaseRun(repository: string, runId: number): Promise<BaseRunEvidence> {
    const [runValue, jobsValue] = await Promise.all([
        githubJson(`/repos/${repository}/actions/runs/${runId}`),
        githubJson(`/repos/${repository}/actions/runs/${runId}/jobs?filter=latest&per_page=100`),
    ]);
    const run = runValue as {
        event?: string;
        head_sha?: string;
        pull_requests?: Array<{ base?: { sha?: string }; number?: number }>;
        repository?: { full_name?: string };
        path?: string;
    };
    const jobs = jobsValue as { jobs?: Array<{ conclusion?: string; name?: string }> };
    const identity = extractBaseRunIdentity(run.pull_requests, jobs.jobs);
    const e2e = summarizeE2EJobs(jobs.jobs);
    return {
        baseSha: identity.baseSha,
        checksConclusion: jobs.jobs?.find(({ name }) => name === 'checks')?.conclusion,
        ...e2e,
        event: run.event ?? '',
        headSha: run.head_sha ?? '',
        pullRequestNumber: identity.pullRequestNumber,
        repository: run.repository?.full_name ?? '',
        workflowPath: run.path,
    };
}

/**
 * Searches only the latest successful runs on the current PR branch. Missing API, lineage, job,
 * or path evidence returns no receipt so the caller keeps full Linux and macOS coverage.
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
            await capture('git', [
                'merge-base',
                '--is-ancestor',
                run.head_sha ?? '',
                input.currentHeadSha,
            ]);
            changedFiles = nullSeparatedPaths(
                await capture(
                    'git',
                    greenReuseDiffArguments(run.head_sha ?? '', input.currentHeadSha),
                ),
            );
        } catch {
            lastReason = `run ${run.id} is not an available ancestor of the current head`;
            continue;
        }
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
    const reason = decision.reason.replace(/[\r\n]+/gu, ' ');
    if (output) {
        await appendFile(
            output,
            [
                `mode=${decision.mode}`,
                `reason=${reason}`,
                `base_run=${decision.baseRunId ?? ''}`,
                `validated_tree=${decision.validatedTree ?? ''}`,
                `e2e_tests=${JSON.stringify(decision.e2eTests ?? [])}`,
                `e2e_pool=${decision.e2ePool ?? 'control'}`,
                `checks_scope=${execution.checksScope}`,
                `run_e2e=${String(execution.runE2E)}`,
                `e2e_profile=${execution.e2eProfile}`,
                `changed_files=${JSON.stringify(executionChangedFiles)}`,
                `reused_e2e_run=${greenReuse.reusableGreenRun?.runId ?? ''}`,
                `reused_e2e_head=${greenReuse.reusableGreenRun?.headSha ?? ''}`,
            ].join('\n') + '\n',
        );
    }
    if (summary) {
        await appendFile(
            summary,
            `## CI execution plan\n\n- Mode: \`${decision.mode}\`\n- Retry reason: ${reason}\n- Checks: \`${execution.checksScope}\`\n- E2E: ${execution.runE2E ? `\`${execution.e2eProfile}\`` : 'skipped'}\n- Plan reason: ${execution.reason}\n- Base run: ${decision.baseRunId ?? 'none'}\n- Validated tree: \`${decision.validatedTree ?? 'none'}\`\n- Focused E2E: ${decision.e2eTests?.map((path) => `\`${path}\``).join(', ') ?? 'none'}\n- Failed E2E pool: \`${decision.e2ePool ?? 'control'}\`\n- Reused E2E run: ${greenReuse.reusableGreenRun?.runId ?? 'none'}\n- Reused E2E head: \`${greenReuse.reusableGreenRun?.headSha ?? 'none'}\`\n- Green reuse: ${greenReuse.reason.replace(/[\r\n]+/gu, ' ')}\n- Pull-request changed files: ${allChangedFiles.length}\n- Current checks changed files: ${executionChangedFiles.length}\n`,
        );
    }
    process.stdout.write(`${JSON.stringify(decision)}\n`);
}

async function main(): Promise<void> {
    const eventPath = process.env.GITHUB_EVENT_PATH;
    const repository = process.env.GITHUB_REPOSITORY ?? '';
    if (!eventPath || !repository) throw new Error('GitHub Actions environment is required');
    const event = JSON.parse(await readFile(eventPath, 'utf8')) as {
        before?: string;
        inputs?: {
            e2e_profile?: 'control' | 'optimized' | 'skip';
            runner_probe?: boolean | 'false' | 'true';
        };
        pull_request?: {
            base?: { sha?: string };
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
        ? nullSeparatedPaths(
              await capture('git', ['diff', '--name-only', '-z', `${comparisonBase}...HEAD`]),
          )
        : [];
    let baseRun: BaseRunEvidence | undefined;
    let isAncestor = false;
    let retryChangedFiles: string[] = [];
    let baseRunChangedFiles: string[] = [];
    if (parsed.hint) {
        try {
            baseRun = await loadBaseRun(repository, parsed.hint.baseRunId);
            await capture('git', ['merge-base', '--is-ancestor', baseRun.headSha, 'HEAD']);
            isAncestor = true;
            retryChangedFiles = nullSeparatedPaths(
                await capture('git', ['diff', '--name-only', '-z', `${baseRun.headSha}...HEAD`]),
            );
            baseRunChangedFiles = nullSeparatedPaths(
                await capture('git', [
                    'diff',
                    '--name-only',
                    '-z',
                    `${event.pull_request?.base?.sha ?? ''}...${baseRun.headSha}`,
                ]),
            );
        } catch (error) {
            parsed.error = `verification failed: ${error instanceof Error ? error.message : String(error)}`;
        }
    }
    const retryDecision = evaluateRetryPolicy({
        baseRun,
        baseRunChangedFiles,
        changedFiles: retryChangedFiles,
        currentTree,
        eventName: process.env.GITHUB_EVENT_NAME ?? '',
        hint: parsed.hint,
        hintError: parsed.error,
        isAncestor,
        pullRequestBaseSha: event.pull_request?.base?.sha,
        pullRequestNumber: event.pull_request?.number,
        repository,
        workflowPath: '.github/workflows/ci.yml',
    });
    const packageVersion = (JSON.parse(packageManifest) as { version?: string }).version;
    const executionInput: CIExecutionPlanInput = {
        changedFiles: allChangedFiles,
        dispatchE2EProfile: event.inputs?.e2e_profile,
        eventName: process.env.GITHUB_EVENT_NAME ?? '',
        isReleaseCommit:
            typeof packageVersion === 'string' && commitSubject === `release: v${packageVersion}`,
        pullRequestDraft: event.pull_request?.draft,
        runnerProbe: event.inputs?.runner_probe === true || event.inputs?.runner_probe === 'true',
        retryMode: retryDecision.mode === 'full' ? undefined : retryDecision.mode,
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
                repository,
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
        greenReuse.reusableGreenRun?.changedFiles ?? allChangedFiles,
        greenReuse,
    );
}

if (import.meta.main) {
    await main().catch(async (error) => {
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
    });
}
