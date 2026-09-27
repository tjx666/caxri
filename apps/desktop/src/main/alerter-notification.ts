import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';

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

type AlerterNotificationFailure =
    'capacity_exceeded' | 'exit_failed' | 'spawn_failed' | 'unavailable';

export interface AlerterNotificationDriver {
    isAvailable(): Promise<boolean>;
    show(
        notification: AgentSystemNotification,
        onClick: () => void,
        onFailure: (failure: AlerterNotificationFailure) => void,
    ): AgentSystemNotificationHandle;
}

interface CreateAlerterNotificationDriverOptions {
    /**
     * Absolute path of the image alerter shows as the app icon; omitted, alerter falls back to its own Terminal glyph.
     */
    appIconPath?: string;
    candidates?: readonly string[];
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

async function resolveAlerterExecutable(
    candidates: readonly string[],
): Promise<string | undefined> {
    for (const candidate of candidates) {
        try {
            // eslint-disable-next-line no-await-in-loop -- candidates are ordered by the native Homebrew architecture
            await access(candidate, constants.X_OK);
            return candidate;
        } catch {
            // Continue to the Intel Homebrew location.
        }
    }
    return undefined;
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
    let executablePromise: Promise<string | undefined> | undefined;

    const executable = (): Promise<string | undefined> => {
        executablePromise ??= options.resolveExecutable
            ? options.resolveExecutable()
            : resolveAlerterExecutable(options.candidates ?? ALERTER_CANDIDATES);
        return executablePromise;
    };

    return {
        async isAvailable(): Promise<boolean> {
            return (await executable()) !== undefined;
        },
        show(notification, onClick, onFailure): AgentSystemNotificationHandle {
            let child: ChildProcess | undefined;
            let executablePath: string | undefined;
            let isClosed = false;
            let isFailureReported = false;

            const reportFailure = (failure: AlerterNotificationFailure): void => {
                if (isFailureReported || isClosed) return;
                isFailureReported = true;
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
                child.stdout?.setEncoding('utf8');
                child.stdout?.on('data', (chunk: string) => {
                    if (output.length >= ALERTER_OUTPUT_LIMIT) return;
                    output = `${output}${chunk}`.slice(0, ALERTER_OUTPUT_LIMIT);
                });
                child.once('error', () => reportFailure('spawn_failed'));
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

            // eslint-disable-next-line no-void -- the returned handle owns cancellation and async failures are reported
            void launch().catch(() => reportFailure('spawn_failed'));

            return {
                close(): void {
                    if (isClosed) return;
                    isClosed = true;
                    child?.kill();
                    removeDeliveredNotification();
                },
            };
        },
    };
}
