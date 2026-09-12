import type { ChildProcess } from 'node:child_process';

// The fake Agent performs only local synchronous setup, including one SQLite initialization. Three seconds bounds that
// contract while reserving one second for TERM/KILL cleanup inside Vitest's default five-second test deadline.
const DEFAULT_FIXTURE_STARTUP_DEADLINE_MS = 3_000;
const DEFAULT_TERM_GRACE_MS = 250;
const DEFAULT_FORCE_KILL_DEADLINE_MS = 750;

export interface AgentFixtureProcessLifecycle {
    cleanupTimedOut: boolean;
    errorClass: string | null;
    exitCode: number | null;
    exitElapsedMs: number | null;
    firstByteElapsedMs: number | null;
    forceKillSent: boolean;
    readyElapsedMs: number | null;
    signal: NodeJS.Signals | null;
    spawnObserved: boolean;
    termSent: boolean;
    timedOut: boolean;
}

interface MutableAgentFixtureProcessLifecycle extends AgentFixtureProcessLifecycle {
    closed: boolean;
}

export interface ObservedAgentFixtureProcess {
    readonly child: ChildProcess;
    readonly events: EventTarget;
    readonly startedAt: number;
    readonly state: MutableAgentFixtureProcessLifecycle;
    stdout: string;
}

class AgentFixtureProcessError extends Error {
    readonly lifecycle: AgentFixtureProcessLifecycle;

    constructor(
        reason: 'cleanup-timeout' | 'deadline' | 'early-exit' | 'spawn-error',
        lifecycle: AgentFixtureProcessLifecycle,
    ) {
        super(`Acceptance Agent fixture process ${reason}: ${JSON.stringify(lifecycle)}`);
        this.name = 'AgentFixtureProcessError';
        this.lifecycle = lifecycle;
    }
}

function elapsed(startedAt: number): number {
    return Math.round(performance.now() - startedAt);
}

function lifecycleSnapshot(process: ObservedAgentFixtureProcess): AgentFixtureProcessLifecycle {
    return {
        cleanupTimedOut: process.state.cleanupTimedOut,
        errorClass: process.state.errorClass,
        exitCode: process.state.exitCode,
        exitElapsedMs: process.state.exitElapsedMs,
        firstByteElapsedMs: process.state.firstByteElapsedMs,
        forceKillSent: process.state.forceKillSent,
        readyElapsedMs: process.state.readyElapsedMs,
        signal: process.state.signal,
        spawnObserved: process.state.spawnObserved,
        termSent: process.state.termSent,
        timedOut: process.state.timedOut,
    };
}

function notify(process: ObservedAgentFixtureProcess): void {
    process.events.dispatchEvent(new Event('change'));
}

export function observeAgentFixtureProcess(child: ChildProcess): ObservedAgentFixtureProcess {
    const process: ObservedAgentFixtureProcess = {
        child,
        events: new EventTarget(),
        startedAt: performance.now(),
        state: {
            cleanupTimedOut: false,
            closed: false,
            errorClass: null,
            exitCode: null,
            exitElapsedMs: null,
            firstByteElapsedMs: null,
            forceKillSent: false,
            readyElapsedMs: null,
            signal: null,
            spawnObserved: false,
            termSent: false,
            timedOut: false,
        },
        stdout: '',
    };

    child.once('spawn', () => {
        process.state.spawnObserved = true;
        notify(process);
    });
    child.once('error', (error: Error) => {
        process.state.closed = true;
        process.state.errorClass = error.name;
        process.state.exitElapsedMs = elapsed(process.startedAt);
        notify(process);
    });
    child.once('close', (code, signal) => {
        process.state.closed = true;
        process.state.exitCode = code;
        process.state.exitElapsedMs = elapsed(process.startedAt);
        process.state.signal = signal;
        notify(process);
    });
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
        process.state.firstByteElapsedMs ??= elapsed(process.startedAt);
        process.stdout += chunk;
        notify(process);
    });
    child.stderr?.resume();
    return process;
}

export function getAgentFixtureStdout(process: ObservedAgentFixtureProcess): string {
    return process.stdout;
}

function waitForChange(process: ObservedAgentFixtureProcess, signal: AbortSignal): Promise<void> {
    return Promise.race([
        new Promise<void>((resolve) => {
            process.events.addEventListener('change', () => resolve(), { once: true, signal });
        }),
        new Promise<void>((_resolve, reject) => {
            signal.addEventListener(
                'abort',
                () =>
                    reject(
                        signal.reason instanceof Error
                            ? signal.reason
                            : new Error('Agent fixture process deadline elapsed'),
                    ),
                { once: true },
            );
        }),
    ]);
}

export async function waitForAgentFixtureReady(
    process: ObservedAgentFixtureProcess,
    marker: string,
    options: { deadlineMs?: number } = {},
): Promise<AgentFixtureProcessLifecycle> {
    const deadlineMs = options.deadlineMs ?? DEFAULT_FIXTURE_STARTUP_DEADLINE_MS;
    const signal = AbortSignal.timeout(deadlineMs);
    const waitUntilReady = async (): Promise<AgentFixtureProcessLifecycle> => {
        if (process.stdout.includes(marker)) {
            process.state.readyElapsedMs ??= elapsed(process.startedAt);
            return lifecycleSnapshot(process);
        }
        if (process.state.errorClass) {
            throw new AgentFixtureProcessError('spawn-error', lifecycleSnapshot(process));
        }
        if (process.state.closed) {
            throw new AgentFixtureProcessError('early-exit', lifecycleSnapshot(process));
        }
        try {
            await waitForChange(process, signal);
        } catch (error: unknown) {
            if (!signal.aborted) throw error;
            process.state.timedOut = true;
            throw new AgentFixtureProcessError('deadline', lifecycleSnapshot(process));
        }
        return waitUntilReady();
    };
    return waitUntilReady();
}

export async function waitForAgentFixtureExit(
    process: ObservedAgentFixtureProcess,
    options: { deadlineMs?: number } = {},
): Promise<AgentFixtureProcessLifecycle> {
    const deadlineMs = options.deadlineMs ?? DEFAULT_FIXTURE_STARTUP_DEADLINE_MS;
    const signal = AbortSignal.timeout(deadlineMs);
    const waitUntilExit = async (): Promise<AgentFixtureProcessLifecycle> => {
        if (process.state.closed) {
            if (process.state.errorClass) {
                throw new AgentFixtureProcessError('spawn-error', lifecycleSnapshot(process));
            }
            return lifecycleSnapshot(process);
        }
        try {
            await waitForChange(process, signal);
        } catch (error: unknown) {
            if (!signal.aborted) throw error;
            process.state.timedOut = true;
            throw new AgentFixtureProcessError('deadline', lifecycleSnapshot(process));
        }
        return waitUntilExit();
    };
    return waitUntilExit();
}

async function hasClosedWithinDeadline(
    process: ObservedAgentFixtureProcess,
    deadlineMs: number,
): Promise<boolean> {
    if (process.state.closed) return true;
    const signal = AbortSignal.timeout(deadlineMs);
    const hasClosed = async (): Promise<boolean> => {
        if (process.state.closed) return true;
        try {
            await waitForChange(process, signal);
        } catch (error: unknown) {
            if (!signal.aborted) throw error;
            return false;
        }
        return hasClosed();
    };
    return hasClosed();
}

export async function stopAgentFixtureProcess(
    process: ObservedAgentFixtureProcess,
    options: { forceKillDeadlineMs?: number; termGraceMs?: number } = {},
): Promise<AgentFixtureProcessLifecycle> {
    if (process.state.closed) return lifecycleSnapshot(process);
    const termGraceMs = options.termGraceMs ?? DEFAULT_TERM_GRACE_MS;
    const forceKillDeadlineMs = options.forceKillDeadlineMs ?? DEFAULT_FORCE_KILL_DEADLINE_MS;

    process.state.termSent = true;
    process.child.kill('SIGTERM');
    if (!(await hasClosedWithinDeadline(process, termGraceMs))) {
        process.state.forceKillSent = true;
        process.child.kill('SIGKILL');
        if (!(await hasClosedWithinDeadline(process, forceKillDeadlineMs))) {
            process.state.cleanupTimedOut = true;
            throw new AgentFixtureProcessError('cleanup-timeout', lifecycleSnapshot(process));
        }
    }
    return lifecycleSnapshot(process);
}
