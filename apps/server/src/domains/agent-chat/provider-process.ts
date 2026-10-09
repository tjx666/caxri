import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import process from 'node:process';

import type { SpawnChatProcess } from './chat-provider';

const TERMINATION_GRACE_MS = 1_000;

/**
 * One Chat provider child with piped stdio in its own process group. Owns the termination escalation every provider
 * shares: stdin EOF first (each provider exits on it), then SIGTERM and SIGKILL on the whole group, so an npm-installed
 * shim's native child and the tools the Agent started stop with it.
 */
export class ProviderProcess {
    readonly child: ChildProcessWithoutNullStreams;

    /**
     * Settles once the child closed its stdio, or failed to spawn.
     */
    readonly exited: Promise<void>;

    constructor(options: {
        executable: string;
        args: readonly string[];
        cwd: string;
        environment: NodeJS.ProcessEnv;
        spawnProcess?: SpawnChatProcess;
    }) {
        const spawnProcess = options.spawnProcess ?? spawn;
        this.child = spawnProcess(options.executable, [...options.args], {
            cwd: options.cwd,
            env: options.environment,
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: process.platform !== 'win32',
        });
        this.exited = new Promise((resolve) => {
            this.child.once('close', () => resolve());
            this.child.once('error', () => resolve());
        });
        /**
         * Stderr carries provider tracing that may quote conversation content; drain it without retaining it.
         */
        this.child.stderr.resume();
    }

    private async exitsWithin(timeoutMs: number): Promise<boolean> {
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), timeoutMs);
        });
        const exit = (async () => {
            await this.exited;
            return true as const;
        })();
        try {
            return await Promise.race([exit, timeout]);
        } finally {
            clearTimeout(timer);
        }
    }

    signal(signal: NodeJS.Signals): void {
        const pid = this.child.pid;
        if (pid === undefined) return;
        try {
            if (process.platform === 'win32') this.child.kill(signal);
            else process.kill(-pid, signal);
        } catch {
            try {
                this.child.kill(signal);
            } catch {
                // Already exited.
            }
        }
    }

    get pid(): number | undefined {
        return this.child.pid;
    }

    hasExited(): boolean {
        return this.child.exitCode !== null || this.child.signalCode !== null;
    }

    /**
     * Closes stdin, then escalates to SIGTERM and SIGKILL on the process group until the child is gone.
     */
    async terminate(): Promise<void> {
        try {
            this.child.stdin.end();
        } catch {
            // Already closed.
        }
        if (this.child.pid === undefined || this.hasExited()) return this.exited;
        if ((await this.exitsWithin(TERMINATION_GRACE_MS)) || this.hasExited()) return;
        this.signal('SIGTERM');
        if (!(await this.exitsWithin(TERMINATION_GRACE_MS)) && !this.hasExited())
            this.signal('SIGKILL');
        await this.exited;
    }
}
