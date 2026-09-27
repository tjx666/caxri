import { randomUUID } from 'node:crypto';

import { CaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { runWithObservationContext } from '@caxri/system';

import { countFields } from '../log-count-fields';
import type { ExternalStatusSource } from './command';
import {
    ExternalStatusCliError,
    externalStatusCommandOperation,
    failureReason,
    isNoPullRequest,
} from './command';

/**
 * Production evidence (#1182): with ~160 Sessions and ~90 Projects, one `started` plus one `success` record per
 * external command made `project_status.cli` 62% of `server-core.jsonl` and rotated a 20MB generation every ~40
 * minutes. One aggregate per command operation per minute keeps volume and latency measurable at a bounded cost.
 */
const EXTERNAL_STATUS_WINDOW_MS = 60_000;

const SUMMARY_EVENTS = {
    'project_status.cli': 'project_status.cli_summary',
    'session_pull_requests.cli': 'session_pull_requests.cli_summary',
} as const;

type ExternalStatusCommandEvent = keyof typeof SUMMARY_EVENTS;

/**
 * Failures that describe the machine rather than one request: they repeat identically on every poll of every Session
 * until the user installs, signs in, links, or re-authorizes the CLI. The status UI already names the fix without
 * linking Logs, so only the transition into each state keeps a `warn` record.
 */
const STEADY_FAILURE_KINDS: ReadonlySet<string> = new Set([
    'not-found',
    'not-logged-in',
    'not-linked',
    'permission-denied',
]);

/**
 * `countFields` builds `failure<Reason>` names, so kebab-case reasons such as `no-pull-request` become camel case.
 */
function camelCase(value: string): string {
    return value.replaceAll(/-(\w)/g, (_, letter: string) => letter.toUpperCase());
}

interface OperationWindow {
    calls: number;
    successes: number;
    readonly failureReasons: Map<string, number>;
    maxDurationMs: number;
    totalDurationMs: number;
}

export interface ExternalStatusCommandOptions {
    command: ExternalStatusSource;
    arguments: readonly string[];
    /**
     * The one identifier a per-item query is about, when the caller fans out over several (Linear issue references).
     * Without it a failure is unattributable: the panel shows one error while the log records only that "a" query
     * failed, so a bogus reference cannot be told apart from a real outage. Callers pass a validated identifier — never
     * argv, a URL, or CLI output — so this stays inside the no-prose rule below.
     */
    subject?: string;
    /**
     * A failure the caller expects and turns into an empty value, such as a missing tracking ref or `origin` remote.
     * Its record drops to `debug`: production logged ~2,100 `head.get` warnings in a few hours for branches that merely
     * had no upstream. The window aggregate still counts it.
     */
    isOptional?: boolean;
    run: () => Promise<string>;
}

function exitCodeOf(error: unknown): number | null {
    return error instanceof ExternalStatusCliError &&
        error.exitCode !== null &&
        Number.isSafeInteger(error.exitCode) &&
        error.exitCode >= 0
        ? error.exitCode
        : null;
}

/**
 * Owns what external status commands (`gh`, `vc`, `linear`) record about themselves. A failure keeps its own record
 * with a closed reason, because the Status panel links straight to it and explaining one failure needs the exact
 * command. A success writes nothing by itself; it only feeds the window aggregate (`<event>_summary`, one record per
 * command operation), which carries call counts, the failure-reason distribution, and total and maximum durations.
 *
 * No argv, cwd, stdout, stderr, or error message enters the log. Windows close lazily on the next command after the
 * window elapsed and on {@link flush}; there is no timer, so an idle Server costs nothing.
 */
export class ExternalStatusCommandTelemetry {
    private readonly operations = new Map<string, OperationWindow>();
    /**
     * The steady failure kind each command is currently in, so its repeats drop to `debug` until the command succeeds
     * or fails differently.
     */
    private readonly steadyFailures = new Map<ExternalStatusSource, string>();
    private startedAt: number;
    private lastEventAt: number;

    constructor(
        private readonly logger: StructuredLogger,
        private readonly event: ExternalStatusCommandEvent,
        private readonly now: () => number = Date.now,
        private readonly windowMs = EXTERNAL_STATUS_WINDOW_MS,
    ) {
        this.startedAt = now();
        this.lastEventAt = this.startedAt;
    }

    private record(command: string, operation: string, durationMs: number, reason?: string): void {
        const now = this.now();
        if (now - this.startedAt >= this.windowMs) this.flush();
        this.lastEventAt = now;
        const key = `${command}\u{0}${operation}`;
        let window = this.operations.get(key);
        if (!window) {
            window = {
                calls: 0,
                successes: 0,
                failureReasons: new Map(),
                maxDurationMs: 0,
                totalDurationMs: 0,
            };
            this.operations.set(key, window);
        }
        window.calls += 1;
        window.totalDurationMs += durationMs;
        window.maxDurationMs = Math.max(window.maxDurationMs, durationMs);
        if (reason === undefined) window.successes += 1;
        else {
            const key = camelCase(reason);
            window.failureReasons.set(key, (window.failureReasons.get(key) ?? 0) + 1);
        }
    }

    /**
     * One command identity spans the command while AsyncLocalStorage retains the parent request/session context, so a
     * failure record still names the request or Session that caused it.
     */
    observe(options: ExternalStatusCommandOptions): Promise<string> {
        return runWithObservationContext({ operationId: randomUUID() }, async () => {
            const startedAt = performance.now();
            const fields = {
                command: options.command,
                operation: externalStatusCommandOperation(options.command, options.arguments),
                ...(options.subject !== undefined && { subject: options.subject }),
            };
            try {
                const result = await options.run();
                this.record(fields.command, fields.operation, performance.now() - startedAt);
                this.steadyFailures.delete(options.command);
                return result;
            } catch (error) {
                const durationMs = performance.now() - startedAt;
                const reason = failureReason(error);
                this.record(fields.command, fields.operation, durationMs, reason);
                const kind = error instanceof ExternalStatusCliError ? error.kind : 'other';
                const isRepeatedSteadyFailure =
                    STEADY_FAILURE_KINDS.has(kind) &&
                    this.steadyFailures.get(options.command) === kind;
                if (STEADY_FAILURE_KINDS.has(kind)) this.steadyFailures.set(options.command, kind);
                const isExpected =
                    options.isOptional === true ||
                    isNoPullRequest(error) ||
                    isRepeatedSteadyFailure;
                this.logger.write(isExpected ? 'debug' : 'warn', this.event, {
                    durationMs,
                    fields: {
                        ...fields,
                        result: 'failure',
                        failureKind: kind,
                        failureReason: reason,
                        exitCode: exitCodeOf(error),
                    },
                });
                throw error;
            }
        });
    }

    /**
     * Publishes the open window. Called when the owner is disposed so the last minute before shutdown is not lost.
     */
    flush(): void {
        for (const [key, window] of this.operations) {
            const [command, operation] = key.split('\u{0}', 2);
            this.logger.write('info', SUMMARY_EVENTS[this.event], {
                durationMs: this.lastEventAt - this.startedAt,
                fields: {
                    command,
                    operation,
                    calls: window.calls,
                    successes: window.successes,
                    failures: window.calls - window.successes,
                    totalDurationMs: Math.round(window.totalDurationMs),
                    maxDurationMs: Math.round(window.maxDurationMs),
                    ...countFields('failure', window.failureReasons),
                },
            });
        }
        this.operations.clear();
        this.startedAt = this.now();
        this.lastEventAt = this.startedAt;
    }

    /**
     * Runs a read whose failure the caller turns into an empty value, such as a missing tracking ref or `origin`
     * remote.
     */
    async readOptional(
        command: ExternalStatusSource,
        arguments_: readonly string[],
        run: () => Promise<string>,
    ): Promise<string> {
        try {
            return (
                await this.observe({ command, arguments: arguments_, run, isOptional: true })
            ).trim();
        } catch {
            return '';
        }
    }

    /**
     * A command that succeeded but whose output failed validation. The command record has no parse outcome, so this
     * keeps its own failure record with a safe reason and no CLI output.
     */
    recordParseFailure(command: ExternalStatusSource, error: unknown): void {
        if (!(error instanceof CaxriError) || error.code !== 'VALIDATION') return;
        this.logger.write('warn', this.event, {
            fields: {
                command,
                operation: 'response.parse',
                result: 'failure',
                failureKind: 'other',
                failureReason: 'invalid-response',
                exitCode: null,
            },
        });
    }
}
