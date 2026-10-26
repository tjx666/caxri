import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it } from 'vitest';

import { runExternalCommand } from '../executables';
import { execFileInProcessGroup, isGroupAlive } from '../process-group';

const temporaryDirectories: string[] = [];
const strayPids: number[] = [];

afterEach(async () => {
    const pids = strayPids.slice();
    strayPids.length = 0;
    for (const pid of pids) {
        try {
            process.kill(pid, 'SIGKILL');
        } catch {
            // Already gone, which is what the assertions expect.
        }
    }
    const directories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
});

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
    try {
        await promise;
    } catch (error) {
        return error;
    }
    throw new Error('Expected the command to fail');
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
 * A CLI shaped like the Vercel shim on macOS: the leader starts a grandchild that ignores SIGTERM and keeps the
 * inherited stdout and stderr open, then waits for it. Both report their PIDs so the test can check the whole tree.
 */
async function treeFixture(options: { leaderOutputBytes?: number } = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-process-group-'));
    temporaryDirectories.push(directory);
    const leaderPidFile = join(directory, 'leader.pid');
    const grandchildPidFile = join(directory, 'grandchild.pid');
    const script = join(directory, 'cli');
    await writeFile(
        script,
        [
            '#!/bin/sh',
            `echo $$ > '${leaderPidFile}'`,
            `sh -c 'trap "" TERM; echo $$ > "${grandchildPidFile}"; while :; do sleep 1; done' &`,
            `while [ ! -s '${grandchildPidFile}' ]; do sleep 0.05; done`,
            options.leaderOutputBytes
                ? String.raw`head -c ${options.leaderOutputBytes} /dev/zero | tr '\0' x`
                : ':',
            'wait',
            '',
        ].join('\n'),
    );
    await chmod(script, 0o700);
    const pids = async () => {
        const leader = Number(await readFile(leaderPidFile, 'utf8'));
        const grandchild = Number(await readFile(grandchildPidFile, 'utf8'));
        strayPids.push(leader, grandchild);
        return { leader, grandchild };
    };
    return { directory, pids, script };
}

describe.skipIf(process.platform === 'win32')('execFileInProcessGroup', () => {
    it('stops the whole tree of a timed-out external command before reporting the timeout', async () => {
        const { pids, script } = await treeFixture();
        const failure = await failureOf(
            runExternalCommand(
                'cli',
                [],
                { maxBuffer: 1024, timeout: 500 },
                {
                    environment: () => Promise.resolve({ PATH: '/usr/bin:/bin' }),
                    resolveExecutable: () => Promise.resolve(script),
                },
            ),
        );

        expect(failure).toMatchObject({ killed: true });
        const { leader, grandchild } = await pids();
        // The leader ran in its own group, and that group was empty by the time the promise settled.
        expect(isGroupAlive(leader)).toBe(false);
        expect(isAlive(grandchild)).toBe(false);
    });

    it('stops the whole tree when the output exceeds maxBuffer', async () => {
        const { pids, script } = await treeFixture({ leaderOutputBytes: 64 * 1024 });
        const failure = await failureOf(
            execFileInProcessGroup(script, [], {
                env: { PATH: '/usr/bin:/bin' },
                maxBuffer: 1024,
                timeout: 10_000,
            }),
        );

        expect(failure).toMatchObject({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
        const { grandchild } = await pids();
        expect(isAlive(grandchild)).toBe(false);
    });

    it('stops the whole tree when the caller aborts', async () => {
        const { directory, pids, script } = await treeFixture();
        const controller = new AbortController();
        const running = failureOf(
            execFileInProcessGroup(script, [], {
                env: { PATH: '/usr/bin:/bin' },
                maxBuffer: 1024,
                signal: controller.signal,
                timeout: 10_000,
            }),
        );
        // Abort only once the grandchild exists, so the abort has a tree to stop.
        await expect
            .poll(async () => {
                try {
                    return await readFile(join(directory, 'grandchild.pid'), 'utf8');
                } catch {
                    return '';
                }
            })
            .not.toBe('');
        controller.abort();

        expect(await running).toMatchObject({ name: 'AbortError' });
        const { grandchild } = await pids();
        expect(isAlive(grandchild)).toBe(false);
    });

    it('returns output and keeps the execFile failure shape for commands that exit on their own', async () => {
        await expect(
            execFileInProcessGroup('/bin/sh', ['-c', 'printf out; printf err >&2'], {
                env: {},
                maxBuffer: 1024,
                timeout: 10_000,
            }),
        ).resolves.toEqual({ stdout: 'out', stderr: 'err' });
        await expect(
            execFileInProcessGroup('/bin/sh', ['-c', 'printf denied >&2; exit 4'], {
                env: {},
                maxBuffer: 1024,
                timeout: 10_000,
            }),
        ).rejects.toMatchObject({ code: 4, killed: false, stderr: 'denied' });
        await expect(
            execFileInProcessGroup('/nonexistent/caxri-cli', [], {
                env: {},
                maxBuffer: 1024,
                timeout: 10_000,
            }),
        ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('leaves a daemon alone when its command exits on its own', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-process-group-'));
        temporaryDirectories.push(directory);
        const daemonPidFile = join(directory, 'daemon.pid');
        await execFileInProcessGroup(
            '/bin/sh',
            ['-c', `sleep 30 >/dev/null 2>&1 & echo $! > '${daemonPidFile}'`],
            { env: { PATH: '/usr/bin:/bin' }, maxBuffer: 1024, timeout: 10_000 },
        );
        const daemon = Number(await readFile(daemonPidFile, 'utf8'));
        strayPids.push(daemon);
        expect(isAlive(daemon)).toBe(true);
    });
});
