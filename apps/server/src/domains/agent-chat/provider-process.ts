import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import process from 'node:process';

import { reapGroup } from '../process-group';
import type { SpawnChatProcess } from './chat-provider';
import type { ProviderGroupRegistration } from './provider-process-groups';
import { registerProviderGroup } from './provider-process-groups';

const TERMINATION_GRACE_MS = 1_000;

async function hasSettledWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const settled = (async () => {
        await promise;
        return true as const;
    })();
    try {
        return await Promise.race([settled, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * One Chat provider child with piped stdio in its own process group. Owns the termination escalation every provider
 * shares: stdin EOF first (each provider exits on it), then SIGTERM and SIGKILL on the whole group, so an npm-installed
 * shim's native child and the tools the Agent started stop with it.
 *
 * On POSIX the group is reaped as soon as the leader exits, whether {@link terminate} stopped it or the provider exited
 * or crashed on its own. Reaping at the exit, rather than whenever the Session is later closed, keeps every group
 * signal inside the window where the group ID is provably still this provider's: once the group has been empty for a
 * while, its ID may belong to a new process group (a Terminal's shell leads its own).
 */
export class ProviderProcess {
    /**
     * Settles once the leader process exited. Unlike {@link exited}, it does not wait for stdio, which a surviving group
     * member can hold open.
     */
    private readonly leaderExited: Promise<void>;

    /**
     * Settles once the leader exited and its process group was reaped. On Windows, which has no process groups, it is
     * the leader's exit alone.
     */
    private readonly reaped: Promise<void>;

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
        /**
         * Records the process group while it lives, so a Server Core that is killed before it can reap the group does
         * not leave it behind for good: the next start sweeps it (see `reapStaleProviderGroups`).
         */
        processGroups?: ProviderGroupRegistration;
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
        this.leaderExited = new Promise((resolve) => {
            this.child.once('exit', () => resolve());
        });
        const { pid } = this.child;
        const registered =
            pid !== undefined && process.platform !== 'win32' && options.processGroups
                ? registerProviderGroup(options.processGroups, pid)
                : undefined;
        this.reaped =
            pid !== undefined && process.platform !== 'win32'
                ? this.reapAfterExit(pid, registered, options.processGroups)
                : this.leaderExited;
        /**
         * Stderr carries provider tracing that may quote conversation content; drain it without retaining it.
         */
        this.child.stderr.resume();
    }

    private async reapAfterExit(
        pgid: number,
        registered: Promise<void> | undefined,
        processGroups: ProviderGroupRegistration | undefined,
    ): Promise<void> {
        await this.leaderExited;
        await reapGroup(pgid);
        // The group is empty now: its record must not outlive it, or a reused ID could be mistaken for it later.
        await registered;
        try {
            processGroups?.ledger.forget(pgid);
        } catch {
            // The startup sweep ignores a record whose group is gone.
        }
    }

    /**
     * Waits for `settled` after stdin EOF, escalating to SIGTERM and then SIGKILL on the whole group while the leader
     * lingers. Returns whether it had to signal.
     */
    private async stopLeader(settled: Promise<void>): Promise<boolean> {
        if (this.hasExited() || (await hasSettledWithin(settled, TERMINATION_GRACE_MS)))
            return false;
        if (this.hasExited()) return false;
        this.signal('SIGTERM');
        if (!(await hasSettledWithin(settled, TERMINATION_GRACE_MS)) && !this.hasExited())
            this.signal('SIGKILL');
        return true;
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
     * Closes stdin, escalates to SIGTERM and SIGKILL on the process group until the leader is gone, then stops the
     * group members that outlived it. Bounded: it never waits on a process that ignores SIGKILL or that left the
     * group.
     */
    async terminate(): Promise<void> {
        try {
            this.child.stdin.end();
        } catch {
            // Already closed.
        }
        if (this.child.pid === undefined) return this.exited;
        if (process.platform === 'win32') {
            if (this.hasExited()) return this.exited;
            if (await this.stopLeader(this.exited)) await this.exited;
            return;
        }
        await this.stopLeader(this.leaderExited);
        // Only a leader stuck in an uninterruptible wait outlives SIGKILL; do not hang the caller on it.
        if (!(await hasSettledWithin(this.leaderExited, TERMINATION_GRACE_MS))) return;
        await this.reaped;
        if (await hasSettledWithin(this.exited, TERMINATION_GRACE_MS)) return;
        /**
         * A descendant that left the group (`setsid`, a daemonizing tool) can hold the inherited stdout and stderr open
         * indefinitely. Dropping our read ends releases the pipes and lets `exited` settle without it.
         */
        this.child.stdout.destroy();
        this.child.stderr.destroy();
    }
}
