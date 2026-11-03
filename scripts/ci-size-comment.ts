#!/usr/bin/env bun

/**
 * Posts the sticky pull-request size and performance comment (docs/bundle-size.md#pull-request-size-report). The `PR
 * report comment` workflow runs this from `main` after every CI run, so it never executes pull request code; it only
 * downloads that run's size reports, which `parseSizeReport` treats as untrusted. It imports nothing outside Node
 * built-ins and sibling scripts, so the job needs Bun but no dependency install.
 *
 * Local preview without posting: `bun run scripts/ci-size-comment.ts --dry-run --repo owner/name --head-sha <sha>
 * --head-repository owner/name --head-branch <branch>`
 */

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';

import { formatDeltaPercent } from './ci-bundle-budget';
import type { SizeReport, SizeReportKind } from './ci-size-report';
import { parseSizeReport, SIZE_REPORT_COMPONENTS, SIZE_REPORT_KINDS } from './ci-size-report';
import { execFileAsync } from './exec';

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/ci-size-comment.test.ts
export const COMMENT_MARKER = '<!-- caxri-pr-report:v1 -->';

/**
 * How far back from the merge base the baseline lookup walks. `main` runs cancel each other under concurrency and
 * release commits skip CI, so the merge base itself often has no baseline artifact.
 */
const BASELINE_DEPTH = 30;

/**
 * Baseline artifacts expire after 30 days, so 5 pages of 100 cover every live `main` push at the current merge rate.
 */
const BASELINE_ARTIFACT_PAGES = 5;

const KiB = 1_024;
const MiB = 1_024 * KiB;

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/ci-size-comment.test.ts
export function formatBytes(bytes: number): string {
    const magnitude = Math.abs(bytes);
    if (magnitude >= MiB) return `${(bytes / MiB).toFixed(2)} MiB`;
    if (magnitude >= KiB) return `${(bytes / KiB).toFixed(1)} KiB`;
    return `${bytes} B`;
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/ci-size-comment.test.ts
export function formatSizeChange(current: number, baseline: number | undefined): string {
    if (baseline === undefined) return 'new';
    const delta = current - baseline;
    if (delta === 0) return '0';
    const sign = delta > 0 ? '+' : '-';
    return `${sign}${formatBytes(Math.abs(delta))} (${formatDeltaPercent(current, baseline)})`;
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/ci-size-comment.test.ts
export interface BaselineArtifact {
    runId: number;
    sha: string;
}

/**
 * The baseline closest to the merge base: `ancestors` is ordered newest first, starting at the merge base.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/ci-size-comment.test.ts
export function pickBaseline(
    ancestors: readonly string[],
    artifacts: readonly BaselineArtifact[],
): BaselineArtifact | undefined {
    for (const sha of ancestors) {
        const match = artifacts.find((artifact) => artifact.sha === sha);
        if (match) return match;
    }
    return undefined;
}

const CHAT_SWITCH_SCENARIOS = ['keptAlive', 'cached', 'uncached', 'cold'] as const;

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/ci-size-comment.test.ts
export interface ChatSwitchRow {
    commitsP50?: number;
    interactiveP50Ms?: number;
    readableP50Ms?: number;
    /**
     * The armed baseline's ceiling for `readableMs.p50` (scripts/performance-baseline.agent-chat-switch.json).
     */
    readableThresholdMs?: number;
    scenario: (typeof CHAT_SWITCH_SCENARIOS)[number];
}

const finite = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const at = (value: unknown, path: readonly string[]): unknown =>
    path.reduce<unknown>(
        (current, key) =>
            typeof current === 'object' && current !== null
                ? (current as Record<string, unknown>)[key]
                : undefined,
        value,
    );

/**
 * Reads the p50 figures of an Agent Chat switch receipt. Only finite numbers are kept, so nothing else from the
 * downloaded artifact reaches the comment.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/ci-size-comment.test.ts
export function summarizeChatSwitch(receipt: unknown, baseline: unknown): ChatSwitchRow[] {
    return CHAT_SWITCH_SCENARIOS.map((scenario) => ({
        scenario,
        readableP50Ms: finite(at(receipt, ['scenarios', scenario, 'readableMs', 'p50'])),
        interactiveP50Ms: finite(at(receipt, ['scenarios', scenario, 'interactiveMs', 'p50'])),
        commitsP50: finite(at(receipt, ['scenarios', scenario, 'react', 'commitCount', 'p50'])),
        readableThresholdMs: finite(
            at(baseline, ['metrics', `scenarios.${scenario}.readableMs.p50`, 'thresholdMs']),
        ),
    }));
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/ci-size-comment.test.ts
export interface CommentInput {
    baselines: Partial<Record<SizeReportKind, SizeReport>>;
    headSha: string;
    performance?: {
        rows: ChatSwitchRow[];
        runUrl: string;
        /**
         * Which run measured it: the pull request CI run's `chat-switch-performance` job, or a manual `hosted-full`
         * dispatch's `e2e-perf` job.
         */
        source: 'hosted-full' | 'pull-request';
    };
    reports: Partial<Record<SizeReportKind, SizeReport>>;
    runUrl: string;
}

const SECTION_TITLES: Record<SizeReportKind, string> = {
    desktop: 'Desktop build',
    mobile: 'Mobile (Android)',
    packaged: 'Packaged macOS app',
};

const MISSING_REPORT: Record<SizeReportKind, string> = {
    desktop: '_Not measured: the size report job did not upload a report._',
    mobile: '_Not measured: the mobile export did not upload a report._',
    packaged:
        '_Not measured: only full-scope CI runs package the app (packaging, dependency, or CI changes)._',
};

const short = (sha: string): string => sha.slice(0, 7);

function renderSizeSection(
    kind: SizeReportKind,
    report: SizeReport | undefined,
    baseline: SizeReport | undefined,
): string[] {
    const title = `**${SECTION_TITLES[kind]}**`;
    if (!report) return [title, '', MISSING_REPORT[kind], ''];
    const against = baseline
        ? `compared with \`main\` at \`${short(baseline.sha)}\``
        : `no \`main\` baseline within ${BASELINE_DEPTH} commits, absolute sizes only`;
    const rows = SIZE_REPORT_COMPONENTS[kind].flatMap(({ budgetBytes, label }) => {
        const size = report.components[label];
        if (!size) return [];
        const change = baseline
            ? formatSizeChange(size.bytes, baseline.components[label]?.bytes)
            : '—';
        const budget = budgetBytes === undefined ? '—' : formatBytes(budgetBytes);
        return [`| ${label} | ${formatBytes(size.bytes)} | ${change} | ${budget} |`];
    });
    return [
        `${title} (${against})`,
        '',
        '| Component | Size | Change | Budget |',
        '| --- | ---: | ---: | ---: |',
        ...rows,
        '',
    ];
}

const formatMs = (value: number | undefined): string =>
    value === undefined ? '—' : `${value.toFixed(1)} ms`;

function renderPerformanceSection(performance: CommentInput['performance']): string[] {
    const title = '**Performance**';
    if (!performance)
        return [
            title,
            '',
            '_Not measured: the Agent Chat Session switch benchmark uploaded no receipt for this head._',
            '',
        ];
    const runLabel = performance.source === 'pull-request' ? 'CI run' : 'hosted-full run';
    return [
        `${title} (Agent Chat Session switch, [${runLabel}](${performance.runUrl}); one run on a shared macOS runner, so timings are noisy)`,
        '',
        '| Scenario | Readable p50 | Interactive p50 | React commits p50 | Readable p50 gate |',
        '| --- | ---: | ---: | ---: | ---: |',
        ...performance.rows.map(
            (row) =>
                `| ${row.scenario} | ${formatMs(row.readableP50Ms)} | ${formatMs(row.interactiveP50Ms)} | ` +
                `${row.commitsP50 === undefined ? '—' : String(row.commitsP50)} | ${formatMs(row.readableThresholdMs)} |`,
        ),
        '',
    ];
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/ci-size-comment.test.ts
export function renderComment(input: CommentInput): string {
    return [
        COMMENT_MARKER,
        '### Size and performance report',
        '',
        `Head \`${short(input.headSha)}\` ([CI run](${input.runUrl})). Sizes exclude Source Maps; Change compares with the nearest \`main\` baseline at or before the merge base.`,
        '',
        ...SIZE_REPORT_KINDS.flatMap((kind) =>
            renderSizeSection(kind, input.reports[kind], input.baselines[kind]),
        ),
        ...renderPerformanceSection(input.performance),
    ].join('\n');
}

/**
 * Artifact names. A `main` push uploads baselines under a distinct name so the baseline lookup can list them without
 * paging through every pull request's reports.
 */
const reportArtifact = (kind: SizeReportKind): string => `size-report-${kind}`;
const baselineArtifact = (kind: SizeReportKind): string => `size-baseline-${kind}`;
const CHAT_SWITCH_ARTIFACT = 'agent-chat-switch-performance-receipt';
const CHAT_SWITCH_RECEIPT = 'agent-chat-session-switch.json';

async function gh(arguments_: string[]): Promise<string> {
    const { stdout } = await execFileAsync('gh', arguments_, { maxBuffer: 32 * MiB });
    return stdout;
}

async function ghJson<T>(path: string): Promise<T> {
    return JSON.parse(await gh(['api', path])) as T;
}

interface WorkflowRun {
    created_at: string;
    event: string;
    html_url: string;
    id: number;
    status: string;
}

/**
 * Downloads one artifact into a fresh directory and returns its single file's text, or `undefined` when the run has no
 * such artifact (a skipped job, or an expired upload).
 */
async function downloadArtifactFile(
    repo: string,
    runId: number,
    name: string,
    file: string,
    scratch: string,
): Promise<string | undefined> {
    const directory = await mkdtemp(join(scratch, `${name}-`));
    try {
        await gh(['run', 'download', String(runId), '-R', repo, '-n', name, '-D', directory]);
    } catch {
        return undefined;
    }
    const files = await readdir(directory);
    if (!files.includes(file)) return undefined;
    return readFile(join(directory, file), 'utf8');
}

async function readReport(
    repo: string,
    runId: number,
    artifact: string,
    kind: SizeReportKind,
    scratch: string,
): Promise<SizeReport | undefined> {
    const text = await downloadArtifactFile(repo, runId, artifact, `${kind}.json`, scratch);
    if (text === undefined) return undefined;
    try {
        return parseSizeReport(text, kind);
    } catch (error) {
        console.warn(`Ignoring ${artifact} from run ${runId}: ${String(error)}`);
        return undefined;
    }
}

async function findBaseline(
    repo: string,
    ancestors: readonly string[],
    kind: SizeReportKind,
    scratch: string,
): Promise<SizeReport | undefined> {
    const name = baselineArtifact(kind);
    const candidates: BaselineArtifact[] = [];
    let picked: BaselineArtifact | undefined;
    // Newest first, one artifact per `main` push: an older merge base sits pages back, so page until it is found.
    for (let page = 1; !picked && page <= BASELINE_ARTIFACT_PAGES; page++) {
        // eslint-disable-next-line no-await-in-loop -- each page decides whether the next one is needed
        const { artifacts } = await ghJson<{
            artifacts: Array<{
                expired: boolean;
                workflow_run?: {
                    head_branch?: string;
                    head_repository_id?: number;
                    head_sha?: string;
                    id?: number;
                    repository_id?: number;
                };
            }>;
        }>(`repos/${repo}/actions/artifacts?name=${name}&per_page=100&page=${page}`);
        candidates.push(
            ...artifacts.flatMap(({ expired, workflow_run: run }) =>
                !expired &&
                run?.id !== undefined &&
                run.head_sha !== undefined &&
                run.head_branch === 'main' &&
                // A fork's pull request run can upload any artifact name, but never from this repository's own `main`.
                run.head_repository_id === run.repository_id
                    ? [{ runId: run.id, sha: run.head_sha }]
                    : [],
            ),
        );
        picked = pickBaseline(ancestors, candidates);
        if (artifacts.length < 100) break;
    }
    if (!picked) return undefined;
    const report = await readReport(repo, picked.runId, name, kind, scratch);
    return report?.sha === picked.sha ? report : undefined;
}

/**
 * The armed Agent Chat switch baseline from the checked-out `main`, whose ceilings the performance rows show.
 */
async function readChatSwitchBaseline(): Promise<unknown> {
    return JSON.parse(
        await readFile(
            new URL('performance-baseline.agent-chat-switch.json', import.meta.url),
            'utf8',
        ),
    );
}

async function main(): Promise<void> {
    const { values } = parseArgs({
        options: {
            'dry-run': { type: 'boolean', default: false },
            'head-branch': { type: 'string', default: process.env.CAXRI_REPORT_HEAD_BRANCH },
            'head-repository': {
                type: 'string',
                default: process.env.CAXRI_REPORT_HEAD_REPOSITORY,
            },
            'head-sha': { type: 'string', default: process.env.CAXRI_REPORT_HEAD_SHA },
            'repo': { type: 'string', default: process.env.GITHUB_REPOSITORY },
        },
    });
    const repo = values.repo;
    const headSha = values['head-sha'];
    const headRepo = values['head-repository'];
    const headBranch = values['head-branch'];
    if (!repo || !headSha || !headRepo || !headBranch)
        throw new Error('--repo, --head-sha, --head-repository, and --head-branch are required');
    if (!/^[0-9a-f]{40}$/u.test(headSha)) throw new Error('--head-sha must be a full commit SHA');

    // The pull request comes from the head, never from an artifact: fork runs carry no `pull_requests` association.
    const headOwner = headRepo.split('/', 1)[0];
    const pulls = await ghJson<
        Array<{ head: { repo: { full_name: string } | null; sha: string }; number: number }>
    >(
        `repos/${repo}/pulls?state=open&per_page=10&head=${encodeURIComponent(`${headOwner}:${headBranch}`)}`,
    );
    const pull = pulls.find(
        ({ head }) => head.sha === headSha && head.repo?.full_name === headRepo,
    );
    if (!pull) {
        console.log(`No open pull request has head ${headSha}; nothing to report.`);
        return;
    }

    const { workflow_runs: runs } = await ghJson<{ workflow_runs: WorkflowRun[] }>(
        `repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${headSha}&per_page=50`,
    );
    const newestFirst = runs
        .filter((run) => run.status === 'completed')
        .toSorted((left, right) => right.created_at.localeCompare(left.created_at));
    const sizeRun = newestFirst.find((run) => run.event === 'pull_request');
    if (!sizeRun) {
        console.log('No completed pull request CI run on this head yet.');
        return;
    }

    const scratch = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), 'caxri-pr-report-'));
    try {
        const reports: CommentInput['reports'] = {};
        for (const kind of SIZE_REPORT_KINDS) {
            // eslint-disable-next-line no-await-in-loop -- a handful of small downloads; serial keeps API use polite
            const report = await readReport(repo, sizeRun.id, reportArtifact(kind), kind, scratch);
            if (report?.sha === headSha) reports[kind] = report;
        }
        if (!reports.desktop) {
            console.log(`Run ${sizeRun.id} uploaded no desktop size report; nothing to report.`);
            return;
        }

        const { merge_base_commit: mergeBase } = await ghJson<{
            merge_base_commit: { sha: string };
        }>(`repos/${repo}/compare/main...${headSha}`);
        const ancestors = (
            await ghJson<Array<{ sha: string }>>(
                `repos/${repo}/commits?sha=${mergeBase.sha}&per_page=${BASELINE_DEPTH}`,
            )
        ).map(({ sha }) => sha);
        const baselines: CommentInput['baselines'] = {};
        for (const kind of SIZE_REPORT_KINDS) {
            if (!reports[kind]) continue;
            // eslint-disable-next-line no-await-in-loop -- see above
            const baseline = await findBaseline(repo, ancestors, kind, scratch);
            if (baseline) baselines[kind] = baseline;
        }

        let performance: CommentInput['performance'];
        // The pull request run's own `chat-switch-performance` job first, then the newest `hosted-full` dispatch, for
        // a head whose pull request run skipped it.
        const performanceRuns = [
            sizeRun,
            ...newestFirst.filter(({ event }) => event === 'workflow_dispatch'),
        ];
        for (const run of performanceRuns) {
            // eslint-disable-next-line no-await-in-loop -- stops at the newest run that carries a receipt
            const receipt = await downloadArtifactFile(
                repo,
                run.id,
                CHAT_SWITCH_ARTIFACT,
                CHAT_SWITCH_RECEIPT,
                scratch,
            );
            if (receipt === undefined) continue;
            let parsed: unknown;
            try {
                parsed = JSON.parse(receipt);
            } catch (error) {
                // A pull request run uploads untrusted bytes; a malformed receipt must not drop the size report.
                console.warn(
                    `Ignoring ${CHAT_SWITCH_ARTIFACT} from run ${run.id}: ${String(error)}`,
                );
                continue;
            }
            // eslint-disable-next-line no-await-in-loop -- runs once, right before the loop exits
            const baseline = await readChatSwitchBaseline();
            performance = {
                rows: summarizeChatSwitch(parsed, baseline),
                runUrl: run.html_url,
                source: run.event === 'pull_request' ? 'pull-request' : 'hosted-full',
            };
            break;
        }

        const body = renderComment({
            baselines,
            headSha,
            performance,
            reports,
            runUrl: sizeRun.html_url,
        });
        if (values['dry-run']) {
            console.log(body);
            return;
        }

        // A newer push makes this report stale; that push's own CI run posts the fresh one.
        const current = await ghJson<{ head: { sha: string } }>(
            `repos/${repo}/pulls/${pull.number}`,
        );
        if (current.head.sha !== headSha) {
            console.log(`Pull request #${pull.number} moved past ${headSha}; skipping.`);
            return;
        }
        const existing = (
            await gh([
                'api',
                '--paginate',
                `repos/${repo}/issues/${pull.number}/comments?per_page=100`,
                '--jq',
                `.[] | select(.user.login == "github-actions[bot]" and (.body | startswith("${COMMENT_MARKER}"))) | .id`,
            ])
        )
            .split('\n')
            .find(Boolean);
        const bodyFile = join(scratch, 'comment.md');
        await writeFile(bodyFile, body, 'utf8');
        await gh([
            'api',
            '-X',
            existing ? 'PATCH' : 'POST',
            existing
                ? `repos/${repo}/issues/comments/${existing}`
                : `repos/${repo}/issues/${pull.number}/comments`,
            '-F',
            `body=@${bodyFile}`,
        ]);
        console.log(
            `${existing ? 'Updated' : 'Posted'} the size report on pull request #${pull.number}.`,
        );
    } finally {
        await rm(scratch, { force: true, recursive: true });
    }
}

if (import.meta.main) {
    await main();
}
