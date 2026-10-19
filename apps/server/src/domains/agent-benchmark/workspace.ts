import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

import type { BenchmarkCheckResult, BenchmarkDiffStat, BenchmarkRun } from '@caxri/protocol';

import { ProviderProcess } from '../agent-chat';
import { runExternalCommand } from '../executables';

const GIT_TIMEOUT_MS = 120_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
const MAX_ATTEMPT_DIFF_BYTES = 512 * 1024;
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
 * Limits a Git command to a Project's subfolder; `--` keeps the path from reading as an option or revision.
 */
function pathspec(subpath: string | undefined): string[] {
    return subpath ? ['--', subpath] : [];
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
    private async stageAll(directory: string, subpath: string | undefined): Promise<void> {
        await git(directory, ['add', '--all', ...pathspec(subpath)]);
    }

    runDirectory(runId: string): string {
        return join(this.root, runId);
    }

    /**
     * The Attempt's clone: always a whole Git repository, even when the Project is a subfolder of one.
     */
    attemptDirectory(runId: string, attemptId: string): string {
        return join(this.root, runId, attemptId);
    }

    /**
     * Where the Agent and the check command work: the clone itself, or the Project's folder inside it when the Project
     * is a subfolder of its repository.
     */
    attemptWorkingDirectory(runId: string, attemptId: string, subpath?: string): string {
        const directory = this.attemptDirectory(runId, attemptId);
        return subpath ? join(directory, subpath) : directory;
    }

    /**
     * Finds what a Project-mode run starts every Attempt from: the Project's `HEAD` when the run starts, the root of
     * the repository holding the Project (the thing `git clone` accepts), and the Project's folder relative to that
     * root (`undefined` when the Project is the root). Rejects when the Project has no commit or its folder is not in
     * `HEAD`, because the clone could not contain it.
     */
    async locateProject(
        projectRoot: string,
    ): Promise<{ head: string; repoRoot: string; subpath?: string }> {
        const [{ stdout: head }, { stdout: repoRoot }, { stdout: prefix }] = await Promise.all([
            git(projectRoot, ['rev-parse', 'HEAD']),
            git(projectRoot, ['rev-parse', '--show-toplevel']),
            git(projectRoot, ['rev-parse', '--show-prefix']),
        ]);
        const subpath = prefix.trim().replace(/\/+$/, '');
        if (subpath) await git(projectRoot, ['cat-file', '-e', `HEAD:${subpath}`]);
        return {
            head: head.trim(),
            repoRoot: repoRoot.trim(),
            ...(subpath && { subpath }),
        };
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

    async diffStat(
        runId: string,
        attemptId: string,
        base: string,
        subpath?: string,
    ): Promise<BenchmarkDiffStat> {
        const directory = this.attemptDirectory(runId, attemptId);
        await this.stageAll(directory, subpath);
        const { stdout } = await git(directory, [
            'diff',
            '--cached',
            '--numstat',
            base,
            ...pathspec(subpath),
        ]);
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
        subpath?: string,
    ): Promise<{ diff: string; truncated: boolean }> {
        const directory = this.attemptDirectory(runId, attemptId);
        await this.stageAll(directory, subpath);
        try {
            const { stdout } = await git(
                directory,
                ['diff', '--cached', '--no-color', base, ...pathspec(subpath)],
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
     *
     * The shell leads its own process group, so a timeout or Stop ends everything the command started (test workers, a
     * dev server it backgrounded), not only `sh`, and a member that outlives a passing command is stopped too.
     */
    async check(
        runId: string,
        attemptId: string,
        command: string,
        timeoutMs: number,
        signal: AbortSignal,
        subpath?: string,
    ): Promise<BenchmarkCheckResult> {
        const startedAt = Date.now();
        const durationMs = () => Date.now() - startedAt;
        const shell = new ProviderProcess({
            executable: 'sh',
            // One combined stream, so the tail interleaves output the way a terminal shows it.
            args: ['-c', `exec 2>&1\n${command}`],
            cwd: this.attemptWorkingDirectory(runId, attemptId, subpath),
            environment: process.env,
        });
        shell.child.stdin.end();
        let output = '';
        shell.child.stdout.setEncoding('utf8');
        shell.child.stdout.on('data', (chunk: string) => {
            output = (output + chunk).slice(-CHECK_OUTPUT_TAIL);
        });
        const ended = new Promise<{ code: number | null } | { error: Error }>((resolve) => {
            shell.child.once('exit', (code) => resolve({ code }));
            shell.child.once('error', (error) => resolve({ error }));
        });
        const { promise: interrupted, resolve: interrupt } = Promise.withResolvers<
            'timedOut' | 'stopped'
        >();
        const timer = setTimeout(() => interrupt('timedOut'), timeoutMs);
        const onAbort = () => interrupt('stopped');
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
        try {
            const result = await Promise.race([ended, interrupted]);
            if (typeof result === 'string') {
                await shell.terminate();
                return result === 'timedOut'
                    ? { status: 'timedOut', durationMs: durationMs(), outputTail: output }
                    : { status: 'error', durationMs: durationMs(), outputTail: output };
            }
            // Waits for the group to be reaped and the output drained.
            await shell.exited;
            if ('error' in result)
                return {
                    status: 'error',
                    durationMs: durationMs(),
                    outputTail: result.error.message.slice(0, 500),
                };
            if (result.code === 0)
                return {
                    status: 'passed',
                    exitCode: 0,
                    durationMs: durationMs(),
                    outputTail: output,
                };
            return {
                status: 'failed',
                ...(result.code !== null && { exitCode: result.code }),
                durationMs: durationMs(),
                outputTail: output,
            };
        } finally {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
        }
    }

    async removeRun(runId: string): Promise<void> {
        const directory = resolve(this.runDirectory(runId));
        // A recursive delete must never climb out of the runs folder, whatever ID reaches it.
        if (dirname(directory) !== resolve(this.root))
            throw new Error('Benchmark run folder is outside the runs folder');
        await rm(directory, { recursive: true, force: true });
    }
}
