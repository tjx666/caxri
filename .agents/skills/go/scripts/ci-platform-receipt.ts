import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { PLATFORM_NEUTRAL_CI_COMMANDS } from './platform-neutral-gates';

const execFileAsync = promisify(execFile);
const REPOSITORY = 'tjx666/caxri';

interface WorkflowRun {
    conclusion: string | null;
    event: string;
    head_sha: string;
    html_url: string;
    id: number;
    status: string;
}

interface WorkflowJob {
    conclusion: string | null;
    head_sha: string;
    name: string;
    steps?: Array<{ conclusion: string | null; name: string; status: string }>;
}

export interface CiPlatformReceipt {
    commands: string[];
    headSha: string;
    runId: number;
    runUrl: string;
}

export interface CiPlatformReceiptApi {
    listJobs(runId: number): Promise<WorkflowJob[]>;
    listRuns(headSha: string): Promise<WorkflowRun[]>;
}

async function githubJson<T>(path: string): Promise<T> {
    const { stdout } = await execFileAsync('gh', ['api', path], {
        maxBuffer: 2 * 1024 * 1024,
        timeout: 15_000,
    });
    return JSON.parse(stdout) as T;
}

const githubApi: CiPlatformReceiptApi = {
    async listJobs(runId) {
        const response = await githubJson<{ jobs: WorkflowJob[] }>(
            `repos/${REPOSITORY}/actions/runs/${runId}/jobs?filter=latest&per_page=100`,
        );
        return response.jobs;
    },
    async listRuns(headSha) {
        const response = await githubJson<{ workflow_runs: WorkflowRun[] }>(
            `repos/${REPOSITORY}/actions/workflows/ci.yml/runs?head_sha=${headSha}&per_page=30`,
        );
        return response.workflow_runs;
    },
};

/**
 * A successful workflow alone does not prove full platform coverage: focused and optimized runs can skip the `checks`
 * job, while pull-request checks currently run on a synthetic merge. Require the full-check step and its job to have
 * executed on the requested commit itself.
 */
export async function readCiPlatformReceipt(
    headSha: string,
    api: CiPlatformReceiptApi = githubApi,
): Promise<CiPlatformReceipt | null> {
    if (!/^[0-9a-f]{40}$/u.test(headSha)) throw new Error('CI receipt requires a full commit SHA');
    const runs = await api.listRuns(headSha);
    for (const run of runs) {
        if (
            run.head_sha !== headSha ||
            run.status !== 'completed' ||
            run.conclusion !== 'success' ||
            !['push', 'workflow_dispatch'].includes(run.event)
        ) {
            continue;
        }
        // eslint-disable-next-line no-await-in-loop -- each candidate run must be verified independently
        const jobs = await api.listJobs(run.id);
        const fullChecks = jobs.find(
            (job) =>
                job.name === 'checks' &&
                job.head_sha === headSha &&
                job.conclusion === 'success' &&
                job.steps?.some(
                    (step) =>
                        step.name === 'Run full platform checks' &&
                        step.status === 'completed' &&
                        step.conclusion === 'success',
                ),
        );
        if (fullChecks) {
            return {
                commands: [...PLATFORM_NEUTRAL_CI_COMMANDS],
                headSha,
                runId: run.id,
                runUrl: run.html_url,
            };
        }
    }
    return null;
}
