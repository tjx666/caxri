import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import { execFileAsync, preferredShell } from '@caxri/system';

import type { AgentSystemNotification, AgentSystemNotificationHandle } from './agent-notifications';

const ALERTER_CANDIDATES = ['/opt/homebrew/bin/alerter', '/usr/local/bin/alerter'] as const;
const ALERTER_OUTPUT_LIMIT = 16 * 1024;
/**
 * How long a banner stays before alerter withdraws it, which also removes it from Notification Center. Each banner owns
 * a waiting alerter process so a click can still route back to its Session; 30 seconds leaves time to read the reply
 * summary while bounding that process lifetime.
 */
const ALERTER_TIMEOUT_SECONDS = 30;
const MAX_ACTIVE_ALERTERS = 32;
/**
 * How long a "helper not found" answer is trusted. A user who runs `brew install` while Caxri is open gets banners
 * delivered through the helper within about a minute without pressing Check Again.
 */
export const ALERTER_NEGATIVE_PROBE_TTL_MS = 60_000;
const LOGIN_SHELL_LOOKUP_TIMEOUT_MS = 3_000;

type AlerterNotificationFailure =
    'capacity_exceeded' | 'exit_failed' | 'spawn_failed' | 'unavailable';

export interface AlerterNotificationDriver {
    /**
     * Whether the helper can be launched. A positive answer is kept for the process; a negative one expires after
     * {@link ALERTER_NEGATIVE_PROBE_TTL_MS}. An expired negative answer is re-probed in the background while the call
     * answers with the current (missing) state, so a login-shell lookup never delays a banner. `isForced` ignores the
     * cache and waits for a fresh look, for the Check Again action.
     */
    isAvailable(options?: { isForced?: boolean }): Promise<boolean>;
    show(
        notification: AgentSystemNotification,
        onClick: () => void,
        onFailure: (failure: AlerterNotificationFailure) => void,
    ): AlerterNotificationHandle;
}

interface AlerterNotificationHandle extends AgentSystemNotificationHandle {
    /**
     * Settles true once the helper process actually started and false when it could not start or the banner closed
     * first, so a test banner can report `sent` only for a launch that happened.
     */
    launched?: Promise<boolean>;
}

interface CreateAlerterNotificationDriverOptions {
    /**
     * Absolute path of the image alerter shows as the app icon; omitted, alerter falls back to its own Terminal glyph.
     */
    appIconPath?: string;
    candidates?: readonly string[];
    /**
     * Finds the helper on the login shell's PATH when the fixed Homebrew locations miss. Defaults to asking the user's
     * login shell, because a Dock-launched app inherits a minimal PATH that lacks custom Homebrew prefixes.
     */
    lookupOnLoginShellPath?: () => Promise<string | undefined>;
    now?: () => number;
    resolveExecutable?: () => Promise<string | undefined>;
    spawnProcess?: (
        executable: string,
        arguments_: readonly string[],
        options: SpawnOptions,
    ) => ChildProcess;
}

export function buildAlerterArguments(
    notification: AgentSystemNotification,
    appIconPath?: string,
): string[] {
    return [
        '--json',
        ...(appIconPath === undefined ? [] : ['--app-icon', appIconPath]),
        '--title',
        notification.title,
        ...(notification.subtitle === undefined ? [] : ['--subtitle', notification.subtitle]),
        '--message',
        notification.body,
        '--sound',
        'default',
        '--timeout',
        String(ALERTER_TIMEOUT_SECONDS),
        /**
         * Alerter uses group as its replacement identity, so this must remain Session-specific.
         */
        '--group',
        notification.id,
    ];
}

export function isAlerterClick(output: string): boolean {
    try {
        const result = JSON.parse(output) as { activationType?: unknown };
        return typeof result.activationType === 'string' && /clicked/i.test(result.activationType);
    } catch {
        return false;
    }
}

/**
 * Whether a cached lookup must be redone: never for a found helper, only after the negative TTL for a miss, and always
 * when forced or when nothing was probed yet.
 */
export function shouldReprobeAlerter(
    cache: { checkedAt: number; found: boolean } | undefined,
    now: number,
    isForced: boolean,
): boolean {
    if (isForced || !cache) return true;
    return !cache.found && now - cache.checkedAt >= ALERTER_NEGATIVE_PROBE_TTL_MS;
}

async function isExecutable(candidate: string): Promise<boolean> {
    try {
        await access(candidate, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

/**
 * Asks the user's login shell where `alerter` lives. The shell is started with structured argv and a fixed command
 * string; nothing from a notification reaches it. Any failure means "not found".
 */
async function lookupAlerterOnLoginShellPath(): Promise<string | undefined> {
    try {
        const { stdout } = await execFileAsync(
            preferredShell(),
            ['-l', '-c', 'command -v alerter'],
            { encoding: 'utf8', maxBuffer: 64 * 1024, timeout: LOGIN_SHELL_LOOKUP_TIMEOUT_MS },
        );
        const resolved = stdout.trim().split('\n').at(-1)?.trim();
        return resolved && isAbsolute(resolved) ? resolved : undefined;
    } catch {
        return undefined;
    }
}

async function resolveAlerterExecutable(
    candidates: readonly string[],
    lookupOnLoginShellPath: () => Promise<string | undefined>,
): Promise<string | undefined> {
    for (const candidate of candidates) {
        // eslint-disable-next-line no-await-in-loop -- candidates are ordered by the native Homebrew architecture
        if (await isExecutable(candidate)) return candidate;
    }
    const fromLoginShell = await lookupOnLoginShellPath();
    return fromLoginShell && (await isExecutable(fromLoginShell)) ? fromLoginShell : undefined;
}

/**
 * Owns alerter subprocesses used by unsigned macOS builds. Notification text is passed as structured argv, never a
 * shell command; like any argv-based tool it remains visible to same-user process inspection while the helper runs.
 */
export function createAlerterNotificationDriver(
    options: CreateAlerterNotificationDriverOptions = {},
): AlerterNotificationDriver {
    const spawnProcess = options.spawnProcess ?? spawn;
    const active = new Set<ChildProcess>();
    const now = options.now ?? Date.now;
    let cache: { checkedAt: number; found: boolean } | undefined;
    let executablePromise: Promise<string | undefined> | undefined;
    let latestProbe = 0;
    let isBackgroundProbing = false;

    const executable = (isForced = false): Promise<string | undefined> => {
        // While a probe is in flight `cache` is unset; concurrent callers share that probe instead of starting more.
        const isNeedsProbe =
            isForced || (cache !== undefined && shouldReprobeAlerter(cache, now(), false));
        if (executablePromise && !isNeedsProbe) return executablePromise;
        const probe = options.resolveExecutable
            ? options.resolveExecutable()
            : resolveAlerterExecutable(
                  options.candidates ?? ALERTER_CANDIDATES,
                  options.lookupOnLoginShellPath ?? lookupAlerterOnLoginShellPath,
              );
        latestProbe += 1;
        const thisProbe = latestProbe;
        const settle = async (): Promise<string | undefined> => {
            try {
                const path = await probe;
                // A newer probe may have replaced this one while it ran; only the latest result owns the cache.
                if (thisProbe === latestProbe)
                    cache = { checkedAt: now(), found: path !== undefined };
                return path;
            } catch (error) {
                // A rejected lookup must not stay cached as the in-flight answer; the next caller probes again.
                if (thisProbe === latestProbe) {
                    executablePromise = undefined;
                    cache = undefined;
                }
                throw error;
            }
        };
        const current = settle();
        executablePromise = current;
        cache = undefined;
        return current;
    };
    /**
     * A helper uninstalled after it was found fails to spawn; forget it so the next banner looks again.
     */
    const forgetExecutable = (): void => {
        latestProbe += 1;
        executablePromise = undefined;
        cache = undefined;
    };

    return {
        async isAvailable(availabilityOptions): Promise<boolean> {
            const isForced = availabilityOptions?.isForced === true;
            const isStaleMiss =
                cache !== undefined && !cache.found && shouldReprobeAlerter(cache, now(), false);
            if (!isForced && (isBackgroundProbing || isStaleMiss)) {
                if (!isBackgroundProbing) {
                    isBackgroundProbing = true;
                    void executable()
                        .catch(() => {})
                        .finally(() => {
                            isBackgroundProbing = false;
                        });
                }
                return false;
            }
            return (await executable(isForced)) !== undefined;
        },
        show(notification, onClick, onFailure): AlerterNotificationHandle {
            const { promise: launched, resolve: resolveLaunched } =
                Promise.withResolvers<boolean>();
            let child: ChildProcess | undefined;
            let executablePath: string | undefined;
            let isClosed = false;
            let isFailureReported = false;

            const reportFailure = (failure: AlerterNotificationFailure): void => {
                if (isFailureReported || isClosed) return;
                isFailureReported = true;
                resolveLaunched(false);
                onFailure(failure);
            };

            const removeDeliveredNotification = (): void => {
                if (!executablePath) return;
                try {
                    const remover = spawnProcess(executablePath, ['--remove', notification.id], {
                        stdio: 'ignore',
                    });
                    remover.unref();
                } catch {
                    // Removal is best-effort after the owning notification has already closed.
                }
            };

            const launch = async (): Promise<void> => {
                executablePath = await executable();
                if (isClosed) return;
                if (!executablePath) {
                    reportFailure('unavailable');
                    return;
                }
                if (active.size >= MAX_ACTIVE_ALERTERS) {
                    reportFailure('capacity_exceeded');
                    return;
                }

                let output = '';
                try {
                    child = spawnProcess(
                        executablePath,
                        buildAlerterArguments(notification, options.appIconPath),
                        {
                            stdio: ['ignore', 'pipe', 'ignore'],
                        },
                    );
                } catch {
                    reportFailure('spawn_failed');
                    return;
                }
                active.add(child);
                child.once('spawn', () => resolveLaunched(true));
                child.stdout?.setEncoding('utf8');
                child.stdout?.on('data', (chunk: string) => {
                    if (output.length >= ALERTER_OUTPUT_LIMIT) return;
                    output = `${output}${chunk}`.slice(0, ALERTER_OUTPUT_LIMIT);
                });
                child.once('error', () => {
                    forgetExecutable();
                    reportFailure('spawn_failed');
                });
                child.once('close', (exitCode, signal) => {
                    if (child) active.delete(child);
                    if (isClosed) return;
                    if (exitCode !== 0 || signal !== null) {
                        reportFailure('exit_failed');
                        return;
                    }
                    if (isAlerterClick(output.trim())) onClick();
                });
            };

            void launch().catch(() => reportFailure('spawn_failed'));

            return {
                launched,
                close(): void {
                    if (isClosed) return;
                    isClosed = true;
                    resolveLaunched(false);
                    child?.kill();
                    removeDeliveredNotification();
                },
            };
        },
    };
}
