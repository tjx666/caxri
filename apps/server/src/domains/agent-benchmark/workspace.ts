import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { BenchmarkCheckResult, BenchmarkDiffStat, BenchmarkRun } from '@caxri/protocol';

import { runExternalCommand } from '../executables';

const GIT_TIMEOUT_MS = 120_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
const MAX_ATTEMPT_DIFF_BYTES = 512 * 1024;
const CHECK_MAX_BUFFER = 4 * 1024 * 1024;
const CHECK_OUTPUT_TAIL = 8_000;

/**
 * Commits Caxri makes in an Attempt folder carry a fixed identity, so they never depend on, or reveal, the user's Git
 * configuration.
 */
const GIT_IDENTITY = [
    '-c',
    'user.name=Caxri Benchmark',
    '-c',
    'user.email=benchmark@caxri.invalid',
];

function git(cwd: string, arguments_: string[], maxBuffer = GIT_MAX_BUFFER) {
    return runExternalCommand('git', [...GIT_IDENTITY, ...arguments_], {
        cwd,
        maxBuffer,
        timeout: GIT_TIMEOUT_MS,
    });
}

/**
 * Git's empty tree. An empty-folder Attempt starts from an empty commit, so diffing against the empty tree covers
 * everything the Agent created, including commits it made itself.
 */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * What an Attempt's diff is taken against: the Project commit it was cloned at, or nothing at all.
 */
export function attemptBase(run: Pick<BenchmarkRun, 'baseCommit'>): string {
    return run.baseCommit ?? EMPTY_TREE;
}

/**
 * Folders a Benchmark owns, under the Server's data directory. Nothing here ever points into a Project.
 */
export class BenchmarkWorkspaces {
    constructor(private readonly root: string) {}

    /**
     * Stages everything the Agent left (new, changed, deleted, and committed files) so the diff against `base` covers
     * all of it. Ignored files stay out, as they would in a review.
     */
    private async stageAll(directory: string): Promise<void> {
        await git(directory, ['add', '--all']);
    }

    runDirectory(runId: string): string {
        return join(this.root, runId);
    }

    attemptDirectory(runId: string, attemptId: string): string {
        return join(this.root, runId, attemptId);
    }

    /**
     * The commit a Project-mode run starts every Attempt from: the Project's `HEAD` when the run starts.
     */
    async projectHead(projectRoot: string): Promise<string> {
        const { stdout } = await git(projectRoot, ['rev-parse', 'HEAD']);
        return stdout.trim();
    }

    /**
     * Creates an Attempt's folder as a Git repository. Project mode clones the Project's repository (hard-linked
     * objects, nothing checked out yet), checks out `base` detached, and drops the remote so an Agent cannot push from
     * it. Empty mode starts a repository with one empty commit. Either way the diff against {@link attemptBase} is
     * exactly what the Agent changed.
     */
    async prepare(
        runId: string,
        attemptId: string,
        source: { kind: 'empty' } | { kind: 'project'; root: string; base: string },
    ): Promise<void> {
        const directory = this.attemptDirectory(runId, attemptId);
        await rm(directory, { recursive: true, force: true });
        await mkdir(this.runDirectory(runId), { recursive: true });
        if (source.kind === 'project') {
            await git(this.runDirectory(runId), [
                'clone',
                '--quiet',
                '--no-checkout',
                source.root,
                directory,
            ]);
            await git(directory, ['checkout', '--quiet', '--detach', source.base]);
            await git(directory, ['remote', 'remove', 'origin']);
            return;
        }
        await mkdir(directory, { recursive: true });
        await git(directory, ['init', '--quiet']);
        await git(directory, ['commit', '--quiet', '--allow-empty', '-m', 'Benchmark start']);
    }

    async diffStat(runId: string, attemptId: string, base: string): Promise<BenchmarkDiffStat> {
        const directory = this.attemptDirectory(runId, attemptId);
        await this.stageAll(directory);
        const { stdout } = await git(directory, ['diff', '--cached', '--numstat', base]);
        const stat: BenchmarkDiffStat = { files: 0, additions: 0, deletions: 0 };
        for (const line of stdout.split('\n')) {
            const fields = line.split('\t', 2);
            if (fields.length < 2) continue;
            const [additions, deletions] = fields;
            stat.files += 1;
            // Binary files report `-` for both counts.
            stat.additions += Math.trunc(Number(additions)) || 0;
            stat.deletions += Math.trunc(Number(deletions)) || 0;
        }
        return stat;
    }

    async diff(
        runId: string,
        attemptId: string,
        base: string,
    ): Promise<{ diff: string; truncated: boolean }> {
        const directory = this.attemptDirectory(runId, attemptId);
        await this.stageAll(directory);
        try {
            const { stdout } = await git(
                directory,
                ['diff', '--cached', '--no-color', base],
                MAX_ATTEMPT_DIFF_BYTES * 4,
            );
            return stdout.length > MAX_ATTEMPT_DIFF_BYTES
                ? { diff: stdout.slice(0, MAX_ATTEMPT_DIFF_BYTES), truncated: true }
                : { diff: stdout, truncated: false };
        } catch (error) {
            const stdout = (error as { stdout?: unknown }).stdout;
            if (typeof stdout === 'string' && stdout.length > 0)
                return { diff: stdout.slice(0, MAX_ATTEMPT_DIFF_BYTES), truncated: true };
            throw error;
        }
    }

    /**
     * Runs the user's check command in the Attempt folder through `sh -c`, the way a task runner would. It is the
     * user's own command for their own machine, so it gets a shell rather than an argv split.
     */
    async check(
        runId: string,
        attemptId: string,
        command: string,
        timeoutMs: number,
        signal: AbortSignal,
    ): Promise<BenchmarkCheckResult> {
        const startedAt = Date.now();
        const durationMs = () => Date.now() - startedAt;
        try {
            const { stdout, stderr } = await runExternalCommand('sh', ['-c', command], {
                cwd: this.attemptDirectory(runId, attemptId),
                maxBuffer: CHECK_MAX_BUFFER,
                timeout: timeoutMs,
                signal,
            });
            return {
                status: 'passed',
                exitCode: 0,
                durationMs: durationMs(),
                outputTail: tail(stdout, stderr),
            };
        } catch (error) {
            const failure = error as {
                code?: unknown;
                killed?: boolean;
                signal?: unknown;
                stdout?: unknown;
                stderr?: unknown;
            };
            const outputTail = tail(failure.stdout, failure.stderr);
            if (failure.killed || failure.signal === 'SIGTERM')
                return { status: 'timedOut', durationMs: durationMs(), outputTail };
            if (typeof failure.code === 'number')
                return {
                    status: 'failed',
                    exitCode: failure.code,
                    durationMs: durationMs(),
                    outputTail,
                };
            return {
                status: 'error',
                durationMs: durationMs(),
                outputTail: error instanceof Error ? error.message.slice(0, 500) : outputTail,
            };
        }
    }

    async removeRun(runId: string): Promise<void> {
        await rm(this.runDirectory(runId), { recursive: true, force: true });
    }
}

function tail(stdout: unknown, stderr: unknown): string {
    const text = [stdout, stderr]
        .filter((part): part is string => typeof part === 'string' && part.length > 0)
        .join('\n');
    return text.length > CHECK_OUTPUT_TAIL ? text.slice(-CHECK_OUTPUT_TAIL) : text;
}
