import { appendFile, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

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
    event: string;
    headSha: string;
    pullRequestNumber?: number;
    repository: string;
    workflowPath?: string;
}

export interface RetryPolicyInput {
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
    /^scripts\/ci-retry-policy\.ts$/,
    /^\.agents\/skills\/e2e-testing\//,
    /^\.agents\/skills\/(?:build|release)\//,
    /^build\//,
    /^RELEASING\.md$/,
];

export function isProtectedRetryPath(path: string): boolean {
    return protectedPathPatterns.some((pattern) => pattern.test(path));
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
    return {
        baseRunId: hint.baseRunId,
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
    return {
        baseSha: identity.baseSha,
        checksConclusion: jobs.jobs?.find(({ name }) => name === 'checks')?.conclusion,
        e2eConclusion: jobs.jobs?.find(({ name }) => name === 'e2e')?.conclusion,
        event: run.event ?? '',
        headSha: run.head_sha ?? '',
        pullRequestNumber: identity.pullRequestNumber,
        repository: run.repository?.full_name ?? '',
        workflowPath: run.path,
    };
}

async function writeDecision(decision: RetryPolicyDecision): Promise<void> {
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
            ].join('\n') + '\n',
        );
    }
    if (summary) {
        await appendFile(
            summary,
            `## CI retry policy\n\n- Mode: \`${decision.mode}\`\n- Reason: ${reason}\n- Base run: ${decision.baseRunId ?? 'none'}\n- Validated tree: \`${decision.validatedTree ?? 'none'}\`\n- Focused E2E: ${decision.e2eTests?.map((path) => `\`${path}\``).join(', ') ?? 'none'}\n`,
        );
    }
    process.stdout.write(`${JSON.stringify(decision)}\n`);
}

async function main(): Promise<void> {
    const eventPath = process.env.GITHUB_EVENT_PATH;
    const repository = process.env.GITHUB_REPOSITORY ?? '';
    if (!eventPath || !repository) throw new Error('GitHub Actions environment is required');
    const event = JSON.parse(await readFile(eventPath, 'utf8')) as {
        pull_request?: {
            base?: { sha?: string };
            number?: number;
        };
    };
    const parsed = parseRetryHint(await capture('git', ['log', '-1', '--format=%B']));
    let baseRun: BaseRunEvidence | undefined;
    let isAncestor = false;
    let changedFiles: string[] = [];
    if (parsed.hint) {
        try {
            baseRun = await loadBaseRun(repository, parsed.hint.baseRunId);
            await capture('git', ['merge-base', '--is-ancestor', baseRun.headSha, 'HEAD']);
            isAncestor = true;
            changedFiles = (
                await capture('git', ['diff', '--name-only', `${baseRun.headSha}...HEAD`])
            )
                .split('\n')
                .filter(Boolean);
        } catch (error) {
            parsed.error = `verification failed: ${error instanceof Error ? error.message : String(error)}`;
        }
    }
    await writeDecision(
        evaluateRetryPolicy({
            baseRun,
            changedFiles,
            currentTree: await capture('git', ['rev-parse', 'HEAD^{tree}']),
            eventName: process.env.GITHUB_EVENT_NAME ?? '',
            hint: parsed.hint,
            hintError: parsed.error,
            isAncestor,
            pullRequestBaseSha: event.pull_request?.base?.sha,
            pullRequestNumber: event.pull_request?.number,
            repository,
            workflowPath: '.github/workflows/ci.yml',
        }),
    );
}

if (import.meta.main) {
    await main().catch(async (error) => {
        await writeDecision({
            mode: 'full',
            reason: `policy evaluation failed closed: ${error instanceof Error ? error.message : String(error)}`,
        });
    });
}
