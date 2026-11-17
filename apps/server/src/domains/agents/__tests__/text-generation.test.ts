import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it } from 'vitest';

import { runAgentTextCommand } from '../text-generation';

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

/**
 * A shim-shaped CLI: the leader starts a grandchild sharing its pipes, records the grandchild's PID, and waits.
 */
async function grandchildFixture() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-text-generation-'));
    temporaryDirectories.push(directory);
    const pidFile = join(directory, 'grandchild.pid');
    const script = `
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
writeFileSync(process.argv[1], String(grandchild.pid));
setInterval(() => {}, 1000);
`;
    const grandchildPid = async () => {
        const pid = Number(await readFile(pidFile, 'utf8'));
        strayPids.push(pid);
        return pid;
    };
    return { arguments: ['-e', script, pidFile], grandchildPid, pidFile };
}

describe.skipIf(process.platform === 'win32')('runAgentTextCommand process tree', () => {
    it('stops the grandchild of a timed-out command before rejecting', async () => {
        const fixture = await grandchildFixture();
        await expect(
            runAgentTextCommand({
                arguments: fixture.arguments,
                cwd: process.cwd(),
                environment: process.env,
                executable: process.execPath,
                input: '',
                limits: { timeoutMs: 700 },
                operation: 'tree fixture',
            }),
        ).rejects.toMatchObject({ code: 'TIMEOUT' });
        // A killed grandchild stays a zombie until launchd reaps it, and `kill(pid, 0)` succeeds on a zombie.
        const pid = await fixture.grandchildPid();
        await expect.poll(() => isAlive(pid), { timeout: 2_000 }).toBe(false);
    });

    it('stops the grandchild of a cancelled command before rejecting', async () => {
        const fixture = await grandchildFixture();
        const controller = new AbortController();
        const run = runAgentTextCommand({
            arguments: fixture.arguments,
            cwd: process.cwd(),
            environment: process.env,
            executable: process.execPath,
            input: '',
            operation: 'tree fixture',
            signal: controller.signal,
        });
        await expect.poll(() => pidFileText(fixture.pidFile), { timeout: 5_000 }).not.toBe('');
        controller.abort();
        await expect(run).rejects.toMatchObject({ code: 'CANCELLED' });
        // A killed grandchild stays a zombie until launchd reaps it, and `kill(pid, 0)` succeeds on a zombie.
        const pid = await fixture.grandchildPid();
        await expect.poll(() => isAlive(pid), { timeout: 2_000 }).toBe(false);
    });
});

describe('runAgentTextCommand', () => {
    it('preserves UTF-8 characters split across stdout chunks', async () => {
        const script = `
const bytes = Buffer.from('中文😀');
process.stdout.write(bytes.subarray(0, 2));
setTimeout(() => {
  process.stdout.write(bytes.subarray(2, 8));
  setTimeout(() => process.stdout.end(bytes.subarray(8)), 10);
}, 10);
`;

        await expect(
            runAgentTextCommand({
                arguments: ['-e', script],
                cwd: process.cwd(),
                environment: process.env,
                executable: process.execPath,
                input: '',
                operation: 'split UTF-8 fixture',
            }),
        ).resolves.toBe('中文😀');
    });
});
