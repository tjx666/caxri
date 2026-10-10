import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProviderProcess } from '../provider-process';

/**
 * Fake providers that start a background tool in their own process group and record the tool's pid in the file named by
 * `$1`. The tool inherits stdout, as a dev server or watcher started from an Agent's shell tool does.
 */
const PROVIDERS = {
    /**
     * Exits on stdin EOF, the way every real provider does.
     */
    exitsOnEof: 'sleep 60 &\necho $! > "$1"\ncat > /dev/null\n',
    /**
     * Exits on its own (a crash or an early exit) before anyone closes the Chat.
     */
    exitsAtOnce: 'sleep 60 &\necho $! > "$1"\n',
    /**
     * Exits on stdin EOF, but its tool ignores SIGTERM. The trap is installed before the pid is recorded.
     */
    toolIgnoresSigterm: `sh -c 'trap "" TERM; echo $$ > "$0"; exec sleep 60' "$1" &\ncat > /dev/null\n`,
} as const;

/**
 * Bounds every wait so a regression fails as an assertion instead of a hung suite.
 */
const TERMINATE_BOUND_MS = 6_000;

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
}

async function hasSettledWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const settled = (async () => {
        await promise;
        return true as const;
    })();
    try {
        return await Promise.race([
            settled,
            new Promise<false>((resolve) => {
                timer = setTimeout(() => resolve(false), timeoutMs);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

describe.skipIf(process.platform === 'win32')('ProviderProcess termination', () => {
    let directory: string;
    const providers: ProviderProcess[] = [];
    const toolPids: number[] = [];

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'caxri-provider-process-'));
    });

    afterEach(async () => {
        for (const pid of toolPids) {
            if (isAlive(pid)) process.kill(pid, 'SIGKILL');
        }
        toolPids.length = 0;
        for (const provider of providers) {
            if (!provider.hasExited()) provider.child.kill('SIGKILL');
            provider.child.stdout.destroy();
            provider.child.stderr.destroy();
        }
        providers.length = 0;
        await rm(directory, { recursive: true, force: true });
    });

    async function start(
        script: keyof typeof PROVIDERS,
    ): Promise<{ provider: ProviderProcess; toolPid: number }> {
        const scriptPath = join(directory, `${script}.sh`);
        const pidFile = join(directory, `${script}.pid`);
        await writeFile(scriptPath, PROVIDERS[script]);
        const provider = new ProviderProcess({
            executable: '/bin/sh',
            args: [scriptPath, pidFile],
            cwd: directory,
            environment: process.env,
        });
        providers.push(provider);
        const toolPid = await vi.waitFor(
            async () => {
                const pid = Number((await readFile(pidFile, 'utf8')).trim());
                expect(pid).toBeGreaterThan(0);
                return pid;
            },
            { timeout: 5_000, interval: 25 },
        );
        toolPids.push(toolPid);
        return { provider, toolPid };
    }

    it('stops a background tool left in the group when the provider exits promptly on stdin EOF', async () => {
        const { provider, toolPid } = await start('exitsOnEof');
        expect(isAlive(toolPid)).toBe(true);
        await expect(hasSettledWithin(provider.terminate(), TERMINATE_BOUND_MS)).resolves.toBe(
            true,
        );
        await vi.waitFor(() => expect(isAlive(toolPid)).toBe(false), {
            timeout: 3_000,
            interval: 25,
        });
        expect(provider.hasExited()).toBe(true);
    });

    it('stops the background tool of a provider that had already exited before the Chat closed', async () => {
        // The group is reaped at the leader's exit, so the tool may already be gone here.
        const { provider, toolPid } = await start('exitsAtOnce');
        await vi.waitFor(() => expect(provider.hasExited()).toBe(true), {
            timeout: 5_000,
            interval: 25,
        });
        await expect(hasSettledWithin(provider.terminate(), TERMINATE_BOUND_MS)).resolves.toBe(
            true,
        );
        await vi.waitFor(() => expect(isAlive(toolPid)).toBe(false), {
            timeout: 3_000,
            interval: 25,
        });
    });

    it('escalates to SIGKILL for a group member that ignores SIGTERM', async () => {
        const { provider, toolPid } = await start('toolIgnoresSigterm');
        expect(isAlive(toolPid)).toBe(true);
        await expect(hasSettledWithin(provider.terminate(), TERMINATE_BOUND_MS)).resolves.toBe(
            true,
        );
        await vi.waitFor(() => expect(isAlive(toolPid)).toBe(false), {
            timeout: 3_000,
            interval: 25,
        });
    });
});
