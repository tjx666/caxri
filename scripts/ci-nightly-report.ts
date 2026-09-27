#!/usr/bin/env bun

import process from 'node:process';

/**
 * Files or updates the single open issue that tracks a red nightly full suite.
 *
 * Ready pull requests run only affected tests, so the nightly run on `main` is the first place a cross-module
 * regression or an unselected E2E spec fails. The report names the failed jobs and steps plus every pull request merged
 * since the previous green nightly, which is the candidate set for the regression.
 */

const NIGHTLY_ISSUE_TITLE = 'Nightly 全量 CI 失败';
const NIGHTLY_ISSUE_LABELS = ['bug', 'ci', 'P1', 'S'];

interface WorkflowJob {
    conclusion?: string | null;
    html_url?: string;
    name?: string;
    steps?: Array<{ conclusion?: string | null; name?: string }>;
}

interface NightlyFailure {
    job: string;
    steps: string[];
    url?: string;
}

interface NightlyReportInput {
    commitCount: number;
    failures: NightlyFailure[];
    headSha: string;
    previousGreenSha?: string;
    pullRequests: number[];
    runUrl: string;
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/ci-nightly-report.test.ts
export function summarizeFailures(jobs: readonly WorkflowJob[]): NightlyFailure[] {
    return jobs
        .filter(({ conclusion }) => conclusion === 'failure')
        .map((job) => ({
            job: job.name ?? 'unknown job',
            steps: (job.steps ?? [])
                .filter(({ conclusion }) => conclusion === 'failure')
                .map(({ name }) => name ?? 'unknown step'),
            url: job.html_url,
        }));
}

/**
 * Squash merges end their subject with `(#123)`; the number is the merged pull request.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/ci-nightly-report.test.ts
export function extractPullRequestNumbers(messages: readonly string[]): number[] {
    const numbers = messages.flatMap((message) => {
        const match = /\(#(\d+)\)\s*$/u.exec(message.split('\n', 1)[0] ?? '');
        return match ? [Number(match[1])] : [];
    });
    return [...new Set(numbers)];
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/ci-nightly-report.test.ts
export function formatNightlyReport(input: NightlyReportInput): string {
    const failures =
        input.failures.length > 0
            ? input.failures
                  .map(({ job, steps, url }) => {
                      const title = url ? `[${job}](${url})` : job;
                      return steps.length > 0
                          ? `- ${title}：${steps.map((step) => `\`${step}\``).join('、')}`
                          : `- ${title}`;
                  })
                  .join('\n')
            : '- 未能读取失败的 job，请打开 run 查看';
    const range = input.previousGreenSha
        ? `\`${input.previousGreenSha.slice(0, 9)}..${input.headSha.slice(0, 9)}\`，共 ${input.commitCount} 个提交`
        : `未找到上一次绿色的 nightly，当前 head 为 \`${input.headSha.slice(0, 9)}\``;
    const pullRequests =
        input.pullRequests.length > 0
            ? input.pullRequests.map((number) => `- #${number}`).join('\n')
            : '- 无（或提交未通过 PR 合入）';
    return [
        `## Nightly 全量失败`,
        '',
        `- Run：${input.runUrl}`,
        `- 提交范围：${range}`,
        '',
        '### 失败的 job 与步骤',
        '',
        failures,
        '',
        '### 上次绿色 nightly 之后合入的 PR',
        '',
        pullRequests,
        '',
        '按 `pull-request` skill 的 CI-only parity 规则，在本地把失败 case 跑两次定位是回归还是偶发失败；回归修复后关闭本 issue。',
    ].join('\n');
}

async function github<T>(path: string, init: RequestInit = {}): Promise<T> {
    const api = process.env.GITHUB_API_URL ?? 'https://api.github.com';
    const response = await fetch(`${api}${path}`, {
        ...init,
        headers: {
            'Accept': 'application/vnd.github+json',
            'Authorization': `Bearer ${process.env.GITHUB_TOKEN ?? ''}`,
            'X-GitHub-Api-Version': '2022-11-28',
            ...init.headers,
        },
    });
    if (!response.ok) throw new Error(`GitHub API ${path} returned ${response.status}`);
    return (await response.json()) as T;
}

async function main(): Promise<void> {
    const repo = process.env.GITHUB_REPOSITORY;
    const runId = process.env.GITHUB_RUN_ID;
    const headSha = process.env.GITHUB_SHA;
    if (!repo || !runId || !headSha) throw new Error('GitHub Actions environment is required');
    const runUrl = `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repo}/actions/runs/${runId}`;

    const { jobs } = await github<{ jobs: WorkflowJob[] }>(
        `/repos/${repo}/actions/runs/${runId}/jobs?per_page=100`,
    );
    const greenRuns = await github<{ workflow_runs: Array<{ head_sha?: string }> }>(
        `/repos/${repo}/actions/workflows/ci.yml/runs?event=schedule&status=success&per_page=1`,
    );
    const previousGreenSha = greenRuns.workflow_runs[0]?.head_sha;
    let commitMessages: string[] = [];
    if (previousGreenSha && previousGreenSha !== headSha) {
        const comparison = await github<{ commits: Array<{ commit: { message: string } }> }>(
            `/repos/${repo}/compare/${previousGreenSha}...${headSha}`,
        );
        commitMessages = comparison.commits.map(({ commit }) => commit.message);
    }
    const body = formatNightlyReport({
        commitCount: commitMessages.length,
        failures: summarizeFailures(jobs),
        headSha,
        previousGreenSha,
        pullRequests: extractPullRequestNumbers(commitMessages),
        runUrl,
    });

    const openIssues = await github<
        Array<{ number: number; pull_request?: unknown; title: string }>
    >(`/repos/${repo}/issues?state=open&labels=ci&per_page=100`);
    const existing = openIssues.find(
        (issue) => !issue.pull_request && issue.title === NIGHTLY_ISSUE_TITLE,
    );
    if (existing) {
        await github(`/repos/${repo}/issues/${existing.number}/comments`, {
            body: JSON.stringify({ body }),
            method: 'POST',
        });
        console.log(`Commented on #${existing.number}`);
        return;
    }
    const created = await github<{ html_url: string }>(`/repos/${repo}/issues`, {
        body: JSON.stringify({ body, labels: NIGHTLY_ISSUE_LABELS, title: NIGHTLY_ISSUE_TITLE }),
        method: 'POST',
    });
    console.log(`Created ${created.html_url}`);
}

if (import.meta.main) await main();
