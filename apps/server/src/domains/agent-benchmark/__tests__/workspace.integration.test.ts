import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { BenchmarkWorkspaces } from '../workspace';

async function attemptFolder() {
    const root = await realpath(await mkdtemp(`${tmpdir()}/caxri-benchmark-workspace-`));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const workspaces = new BenchmarkWorkspaces(root);
    await mkdir(workspaces.attemptDirectory('run', 'attempt'), { recursive: true });
    return workspaces;
}

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/**
 * Starts a background child that would outlive `sh`, records its PID, then waits on it.
 */
const BACKGROUND_COMMAND = 'sleep 30 & echo $! > background.pid; wait';

async function backgroundPid(workspaces: BenchmarkWorkspaces): Promise<number> {
    const file = join(workspaces.attemptDirectory('run', 'attempt'), 'background.pid');
    return Number((await readFile(file, 'utf8')).trim());
}

describe('BenchmarkWorkspaces.check', () => {
    it('reports the exit code and the combined output', async () => {
        const workspaces = await attemptFolder();
        const result = await workspaces.check(
            'run',
            'attempt',
            'echo out; echo err >&2; exit 4',
            10_000,
            new AbortController().signal,
        );

        expect(result).toMatchObject({ status: 'failed', exitCode: 4 });
        expect(result.outputTail).toContain('out');
        expect(result.outputTail).toContain('err');
    });

    it('stops everything the command started when it times out', async () => {
        const workspaces = await attemptFolder();
        const result = await workspaces.check(
            'run',
            'attempt',
            BACKGROUND_COMMAND,
            500,
            new AbortController().signal,
        );

        expect(result.status).toBe('timedOut');
        const pid = await backgroundPid(workspaces);
        await vi.waitFor(() => expect(isAlive(pid)).toBe(false), { timeout: 5_000 });
    });

    it('stops everything the command started when the Attempt is stopped', async () => {
        const workspaces = await attemptFolder();
        const controller = new AbortController();
        const checking = workspaces.check(
            'run',
            'attempt',
            BACKGROUND_COMMAND,
            30_000,
            controller.signal,
        );
        await vi.waitFor(async () => expect(await backgroundPid(workspaces)).toBeGreaterThan(0));
        controller.abort();
        const result = await checking;

        expect(result.status).toBe('error');
        const pid = await backgroundPid(workspaces);
        await vi.waitFor(() => expect(isAlive(pid)).toBe(false), { timeout: 5_000 });
    });

    it('refuses to remove a folder outside the runs folder', async () => {
        const workspaces = await attemptFolder();

        await expect(workspaces.removeRun('../..')).rejects.toThrow('outside the runs folder');
    });
});
