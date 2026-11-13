import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import process from 'node:process';
import { createInterface } from 'node:readline';

import type { SessionKeychainPrompt } from '@caxri/protocol';
import type { ProcessTable, StructuredLogger } from '@caxri/system';
import { logEventCatalog, safeProcessEnvironment, sampleProcessTable } from '@caxri/system';

import type { KeychainLogEvent, KeychainPromptOutcome } from './keychain-prompt-log';
import { displayCommand, findOwningRoot, parseKeychainLogLine } from './keychain-prompt-log';

/**
 * Only securityd's Keychain ACL category: a handful of lines per dialog, so the stream idles at no measurable CPU.
 */
const LOG_STREAM_ARGS = [
    'stream',
    '--style',
    'ndjson',
    '--predicate',
    'process == "securityd" AND category == "kcacl"',
] as const;
/**
 * How often an open dialog's requester is checked for having exited without an answer in the log (killed, or its
 * Terminal closed), which would otherwise leave the marker up.
 */
const LIVENESS_INTERVAL_MS = 5_000;
/**
 * A dialog nobody answered for this long is dropped: the marker must not outlive a prompt the log never closed.
 */
const PROMPT_EXPIRY_MS = 10 * 60_000;
const RESTART_MIN_MS = 5_000;
const RESTART_MAX_MS = 5 * 60_000;
/**
 * A stream that ran this long before ending counts as healthy, so its restart starts from the shortest delay again.
 */
const HEALTHY_RUN_MS = 60_000;

export interface KeychainPromptOwner {
    provider?: string;
    sessionId: string;
}

interface PendingPrompt {
    command: string;
    owner?: KeychainPromptOwner;
    since: number;
}

interface KeychainPromptWatcherOptions {
    homeDirectory?: string;
    isAlive?: (pid: number) => boolean;
    logger: StructuredLogger;
    now?: () => number;
    /**
     * The root PID of every running Terminal and live Chat provider, with the Session that owns it.
     */
    owners: () => ReadonlyMap<number, KeychainPromptOwner>;
    /**
     * Called with the open dialogs by Session after every change.
     */
    onChange: (prompts: ReadonlyMap<string, SessionKeychainPrompt>) => void;
    sampleProcessTable?: () => Promise<ProcessTable>;
    spawnStream?: () => ChildProcess;
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // EPERM means the process exists but belongs to someone else.
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

/**
 * Tells which Session raised a macOS Keychain access dialog, so the user can see who is asking before answering it.
 *
 * Securityd logs `displaying keychain prompt for <path>(<pid>)` when it shows the dialog and `user approved ...` or
 * `user did not approve ...` when it closes. The requester stays blocked in the Security framework while the dialog is
 * up, so its parent chain can still be walked to the Terminal or Chat root that started it. Nothing here reads the
 * Keychain, and the command line it shows never reaches a log.
 */
export class KeychainPromptWatcher {
    private child?: ChildProcess;
    private closed = false;
    private livenessTimer?: ReturnType<typeof setInterval>;
    private readonly pending = new Map<number, PendingPrompt>();
    private restartDelayMs = RESTART_MIN_MS;
    private restartTimer?: ReturnType<typeof setTimeout>;
    private startedAt = 0;

    constructor(private readonly options: KeychainPromptWatcherOptions) {}

    private resolve(
        pid: number,
        outcome: KeychainPromptOutcome | 'exited' | 'expired' | 'streamLost',
    ): void {
        const prompt = this.pending.get(pid);
        if (!prompt) return;
        this.pending.delete(pid);
        this.options.logger.write('info', logEventCatalog.terminal.keychainPromptResolved, {
            durationMs: this.now() - prompt.since,
            fields: { attributed: prompt.owner !== undefined, outcome },
        });
        if (this.pending.size === 0) {
            clearInterval(this.livenessTimer);
            this.livenessTimer = undefined;
        }
        if (prompt.owner) this.publish();
    }

    private publish(): void {
        const bySession = new Map<string, SessionKeychainPrompt>();
        for (const [pid, prompt] of this.pending) {
            if (!prompt.owner) continue;
            const current = bySession.get(prompt.owner.sessionId);
            // One marker per row: the most recent dialog is the one on screen.
            if (current && current.since > prompt.since) continue;
            bySession.set(prompt.owner.sessionId, {
                command: prompt.command,
                pid,
                since: prompt.since,
            });
        }
        this.options.onChange(bySession);
    }

    private ensureLivenessTimer(): void {
        if (this.livenessTimer) return;
        this.livenessTimer = setInterval(() => this.sweep(), LIVENESS_INTERVAL_MS);
        this.livenessTimer.unref();
    }

    private scheduleRestart(reason: 'exited' | 'spawnFailed', code: number | null): void {
        if (this.closed) return;
        // An answer given while the stream is down never reaches us, so a dialog left pending would keep its marker
        // until expiry. Dropping them is the safer error: a still-open dialog stays on screen either way.
        for (const pid of this.pending.keys()) this.resolve(pid, 'streamLost');
        if (this.now() - this.startedAt >= HEALTHY_RUN_MS) this.restartDelayMs = RESTART_MIN_MS;
        const retryInMs = this.restartDelayMs;
        this.restartDelayMs = Math.min(this.restartDelayMs * 2, RESTART_MAX_MS);
        this.options.logger.write('warn', logEventCatalog.terminal.keychainWatchStopped, {
            fields: { code, reason, retryInMs },
        });
        this.restartTimer = setTimeout(() => this.start(), retryInMs);
        this.restartTimer.unref();
    }

    private now(): number {
        return (this.options.now ?? Date.now)();
    }

    start(): void {
        if (this.closed || this.child) return;
        this.startedAt = this.now();
        let child: ChildProcess;
        try {
            child = (this.options.spawnStream ?? spawnLogStream)();
        } catch {
            this.scheduleRestart('spawnFailed', null);
            return;
        }
        this.child = child;
        if (child.stdout) {
            const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
            lines.on('line', (line) => {
                const event = parseKeychainLogLine(line);
                if (event) void this.handle(event);
            });
        }
        child.once('error', () => {
            if (this.child !== child) return;
            this.child = undefined;
            this.scheduleRestart('spawnFailed', null);
        });
        child.once('exit', (code) => {
            if (this.child !== child) return;
            this.child = undefined;
            this.scheduleRestart('exited', code);
        });
    }

    close(): void {
        this.closed = true;
        clearTimeout(this.restartTimer);
        clearInterval(this.livenessTimer);
        this.livenessTimer = undefined;
        const { child } = this;
        this.child = undefined;
        child?.kill('SIGTERM');
    }

    /**
     * Exposed for tests: folds one parsed log event in.
     */
    async handle(event: KeychainLogEvent): Promise<void> {
        if (event.kind === 'resolved') {
            this.resolve(event.pid, event.outcome);
            return;
        }
        if (this.pending.has(event.pid)) return;
        const since = this.now();
        // Reserve the slot before the async read so a quick answer arriving meanwhile still finds it.
        this.pending.set(event.pid, { command: '', since });
        let table: ProcessTable | undefined;
        try {
            table = await (
                this.options.sampleProcessTable ??
                (() => sampleProcessTable({ includeCommand: true }))
            )();
        } catch {
            table = undefined;
        }
        const prompt = this.pending.get(event.pid);
        if (!prompt || prompt.since !== since) return;
        const owner = table ? findOwningRoot(event.pid, table, this.options.owners()) : undefined;
        prompt.owner = owner;
        prompt.command = displayCommand(
            table?.get(event.pid)?.command ?? '',
            this.options.homeDirectory ?? homedir(),
        );
        this.options.logger.write('info', logEventCatalog.terminal.keychainPromptShown, {
            fields: { attributed: owner !== undefined, provider: owner?.provider ?? null },
        });
        this.ensureLivenessTimer();
        if (owner) this.publish();
    }

    /**
     * Exposed for tests: drops dialogs whose requester exited or that expired.
     */
    sweep(): void {
        const now = this.now();
        const isAlive = this.options.isAlive ?? isProcessAlive;
        for (const [pid, prompt] of this.pending) {
            if (!isAlive(pid)) this.resolve(pid, 'exited');
            else if (now - prompt.since >= PROMPT_EXPIRY_MS) this.resolve(pid, 'expired');
        }
    }
}

function spawnLogStream(): ChildProcess {
    return spawn('/usr/bin/log', [...LOG_STREAM_ARGS], {
        env: safeProcessEnvironment(),
        stdio: ['ignore', 'pipe', 'ignore'],
    });
}
