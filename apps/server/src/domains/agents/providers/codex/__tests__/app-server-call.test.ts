import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it } from 'vitest';

import { callCodexAppServer } from '../app-server-call';

const strayPids: number[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pids = [...strayPids];
    strayPids.length = 0;
    for (const pid of pids) {
        try {
            process.kill(pid, 'SIGKILL');
        } catch {
            // Already gone, which is what the assertions expect.
        }
    }
    const directories = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
});

async function pidFileText(path: string): Promise<string> {
    try {
        return await readFile(path, 'utf8');
    } catch {
        return '';
    }
}

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

describe.skipIf(process.platform === 'win32')('callCodexAppServer process tree', () => {
    it('stops the grandchild of a cancelled app-server before rejecting', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-codex-call-'));
        temporaryDirectories.push(directory);
        const pidFile = join(directory, 'grandchild.pid');
        const executable = join(directory, 'codex.cjs');
        // A shim-shaped app-server: the leader starts a grandchild sharing its pipes and never answers.
        await writeFile(
            executable,
            `#!${process.execPath}
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));
setInterval(() => {}, 1000);
`,
            { mode: 0o700 },
        );
        const controller = new AbortController();
        const call = callCodexAppServer(
            {
                cwd: directory,
                environment: { homeDirectory: directory, variables: {} },
                executable,
                purpose: 'tree fixture',
                signal: controller.signal,
            },
            [{ method: 'thread/name/set', params: {} }],
        );
        await expect.poll(() => pidFileText(pidFile), { timeout: 5_000 }).not.toBe('');
        controller.abort();
        await expect(call).rejects.toMatchObject({ code: 'CANCELLED' });
        const pid = Number(await readFile(pidFile, 'utf8'));
        strayPids.push(pid);
        // A killed grandchild stays a zombie until launchd reaps it, and `kill(pid, 0)` succeeds on a zombie.
        await expect.poll(() => isAlive(pid), { timeout: 2_000 }).toBe(false);
    });
});
