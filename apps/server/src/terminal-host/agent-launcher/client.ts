import { Buffer } from 'node:buffer';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawn } from 'node:child_process';
import { closeSync, constants, openSync, readSync } from 'node:fs';
import { createConnection } from 'node:net';
import { basename } from 'node:path';
import process from 'node:process';

import type {
    ManagedAgentLauncherClientMessage,
    ManagedAgentLauncherExit,
    ManagedAgentLaunchPlan,
} from './protocol';
import {
    BoundedJsonLineDecoder,
    encodeJsonLine,
    MAX_MANAGED_AGENT_LAUNCHER_CONTROL_BYTES,
    MAX_MANAGED_AGENT_LAUNCHER_PLAN_BYTES,
    parseManagedAgentLauncherServerMessage,
    validateManagedAgentLaunchPlan,
} from './protocol';

const FORCE_KILL_DELAY_MS = 1_000;
const FAILED_HANDOFF_DRAIN_MS = 50;

function isClosedTerminal(error: unknown): boolean {
    return (
        error !== null &&
        typeof error === 'object' &&
        'code' in error &&
        ['EIO', 'ENXIO', 'ENOTTY', 'EBADF'].includes(String(error.code))
    );
}

/**
 * The Agent and its parent shell share one PTY. Unread Composer bytes can otherwise become a shell command after the
 * Agent exits. Keep the launcher foreground until Host fences the launch, then discard queued input before returning.
 */
function suppressTerminalEcho(): boolean | undefined {
    const terminal = process.stdin;
    if (!terminal.isTTY || typeof terminal.setRawMode !== 'function') return;
    const wasRaw = terminal.isRaw === true;
    terminal.setRawMode(true);
    return wasRaw;
}

function drainPendingTerminalInput(wasRaw: boolean | undefined): void {
    if (wasRaw === undefined) return;
    const terminal = process.stdin;
    /**
     * This synchronous nonblocking read is intentional: the launcher must empty the PTY input queue after Host's exit
     * acknowledgement and before its parent shell can resume. An async stream leaves a return-to-shell window.
     */
    // oxlint-disable-next-line node/no-sync -- Input must be empty before this foreground process returns to the shell.
    const descriptor = openSync('/dev/tty', constants.O_RDONLY | constants.O_NONBLOCK);
    const buffer = Buffer.allocUnsafe(4_096);
    try {
        while (true) {
            try {
                // oxlint-disable-next-line node/no-sync -- A nonblocking read closes the shell handoff window.
                if (readSync(descriptor, buffer, 0, buffer.length, null) === 0) break;
            } catch (error) {
                if (
                    error &&
                    typeof error === 'object' &&
                    'code' in error &&
                    (error.code === 'EAGAIN' || error.code === 'EWOULDBLOCK')
                )
                    break;
                throw error;
            }
        }
    } finally {
        // oxlint-disable-next-line node/no-sync -- Close the exact drain descriptor before restoring terminal mode.
        closeSync(descriptor);
        terminal.setRawMode(wasRaw);
    }
}

export interface RunManagedAgentLauncherOptions {
    socketPath: string;
    launchId: string;
    environment?: NodeJS.ProcessEnv;
    spawnChild?: (
        executable: string,
        arguments_: readonly string[],
        options: SpawnOptions,
    ) => ChildProcess;
}

function launcherFailure(): Error {
    return new Error('Managed Agent launcher failed closed');
}

function didWriteMessage(
    socket: ReturnType<typeof createConnection>,
    message: ManagedAgentLauncherClientMessage,
): boolean {
    if (socket.destroyed || !socket.writable) return false;
    try {
        socket.write(encodeJsonLine(message, MAX_MANAGED_AGENT_LAUNCHER_CONTROL_BYTES));
        return true;
    } catch {
        return false;
    }
}

/**
 * Claims one launch plan and owns exactly one Agent child. The token is removed synchronously before any socket or
 * process work so neither the spawned Agent nor later launcher code can inherit the one-use claim credential.
 */
export function runManagedAgentLauncher(
    options: RunManagedAgentLauncherOptions,
): Promise<ManagedAgentLauncherExit> {
    const environment = options.environment ?? process.env;
    const token = environment.CAXRI_AGENT_LAUNCHER_TOKEN;
    delete environment.CAXRI_AGENT_LAUNCHER_TOKEN;

    if (
        typeof token !== 'string' ||
        token.length === 0 ||
        token.length > 256 ||
        options.launchId.length === 0 ||
        options.launchId.length > 256
    ) {
        return Promise.reject(launcherFailure());
    }

    return new Promise<ManagedAgentLauncherExit>((resolve, reject) => {
        const socket = createConnection(options.socketPath);
        const decoder = new BoundedJsonLineDecoder(MAX_MANAGED_AGENT_LAUNCHER_PLAN_BYTES);
        let child: ChildProcess | undefined;
        let isChildExited = false;
        let forceKillTimer: NodeJS.Timeout | undefined;
        let failedHandoffTimer: NodeJS.Timeout | undefined;
        let isPlanReceived = false;
        let isSettled = false;
        let isTransportFailed = false;
        let pendingExit: ManagedAgentLauncherExit | undefined;
        let isExitAcknowledged = false;
        let isDrainingAfterExit = false;
        let wasRawBeforeExit: boolean | undefined;
        let forwardSigint: () => void = () => {};
        let forwardSighup: () => void = () => {};
        let forwardSigterm: () => void = () => {};

        const settle = (error: Error | undefined, exit?: ManagedAgentLauncherExit): void => {
            if (isSettled) return;
            isSettled = true;
            if (failedHandoffTimer) clearInterval(failedHandoffTimer);
            if (forceKillTimer) clearTimeout(forceKillTimer);
            process.off('SIGINT', forwardSigint);
            process.off('SIGHUP', forwardSighup);
            process.off('SIGTERM', forwardSigterm);
            if (error) reject(error);
            else if (exit) resolve(exit);
            else reject(launcherFailure());
        };

        const settleAfterDrain = (
            error: Error | undefined,
            exit?: ManagedAgentLauncherExit,
        ): void => {
            if (isDrainingAfterExit) return;
            isDrainingAfterExit = true;
            try {
                drainPendingTerminalInput(wasRawBeforeExit);
                if (isExitAcknowledged && !error && exit && !socket.destroyed) {
                    socket.end(
                        encodeJsonLine(
                            { type: 'drained' },
                            MAX_MANAGED_AGENT_LAUNCHER_CONTROL_BYTES,
                        ),
                    );
                } else settle(error, exit);
            } catch {
                settle(launcherFailure());
            }
        };

        const holdUnsafeHandoff = (): void => {
            if (wasRawBeforeExit === undefined) {
                settleAfterDrain(launcherFailure());
                return;
            }
            if (failedHandoffTimer) return;
            process.stderr.write('Agent input handoff failed; close this Terminal to recover.\r\n');
            failedHandoffTimer = setInterval(() => {
                try {
                    drainPendingTerminalInput(true);
                } catch (error) {
                    if (isClosedTerminal(error)) settle(launcherFailure());
                }
            }, FAILED_HANDOFF_DRAIN_MS);
        };

        const terminateChild = (signal: NodeJS.Signals = 'SIGHUP'): void => {
            if (!child || isChildExited) return;
            child.kill(signal);
            if (forceKillTimer) return;
            forceKillTimer = setTimeout(() => {
                if (isChildExited) {
                    return;
                }

                child?.kill('SIGKILL');
                setTimeout(() => {
                    if (!isChildExited) settle(launcherFailure());
                }, 100);
            }, FORCE_KILL_DELAY_MS);
        };

        const failClosed = (): void => {
            if (isTransportFailed) return;
            isTransportFailed = true;
            socket.destroy();
            if (child && !isChildExited) terminateChild();
            else if (!isExitAcknowledged) holdUnsafeHandoff();
            else if (isDrainingAfterExit) settle(launcherFailure());
            else settleAfterDrain(launcherFailure());
        };

        /**
         * A terminal sends SIGINT and SIGHUP to the whole foreground process group, including the Agent child. The
         * launcher observes those signals only to fail closed during startup; forwarding them would signal the child
         * twice. Socket controls are different because they target only this launcher and still require forwarding.
         */
        const observeForegroundSignal = (): void => {
            if (!child || isChildExited) failClosed();
        };
        forwardSigint = observeForegroundSignal;
        forwardSighup = observeForegroundSignal;
        forwardSigterm = () => {
            if (child && !isChildExited) terminateChild('SIGTERM');
            else failClosed();
        };

        const startChild = (value: unknown): void => {
            let plan: ManagedAgentLaunchPlan;
            try {
                plan = validateManagedAgentLaunchPlan(value);
            } catch {
                failClosed();
                return;
            }

            try {
                child = (options.spawnChild ?? spawn)(plan.executable, plan.args, {
                    cwd: plan.cwd,
                    env: plan.environment,
                    stdio: 'inherit',
                    detached: false,
                });
            } catch {
                failClosed();
                return;
            }

            child.once('spawn', () => {
                const processId = child?.pid;
                if (!processId || !didWriteMessage(socket, { type: 'started', processId })) {
                    failClosed();
                }
            });
            child.once('error', (error) => {
                if (!child?.pid) {
                    isChildExited = true;
                    socket.destroy();
                    // Host already confirmed the executable existed while building this plan; a spawn-time ENOENT
                    // means it was removed, renamed, or unmounted in the race since (issue caxri#1345). The launcher
                    // process is about to exit and hand this PTY straight back to an ordinary interactive shell, so
                    // this is the only chance to explain why: without it, the Terminal silently "downgrades" to a
                    // plain shell with no visible reason.
                    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                        process.stderr.write(
                            `${basename(plan.executable)} could not be started: it was not found. It may have been moved, updated, or uninstalled after Caxri last verified it. Falling back to a plain shell.\r\n`,
                        );
                    settle(launcherFailure());
                    return;
                }
                failClosed();
            });
            child.once('exit', (exitCode, signal) => {
                isChildExited = true;
                if (forceKillTimer) clearTimeout(forceKillTimer);
                try {
                    wasRawBeforeExit = suppressTerminalEcho();
                } catch {
                    failClosed();
                    return;
                }
                const exit: ManagedAgentLauncherExit = { exitCode, signal };
                pendingExit = exit;
                if (isTransportFailed) {
                    holdUnsafeHandoff();
                    return;
                }
                if (socket.destroyed || !socket.writable) {
                    holdUnsafeHandoff();
                    return;
                }
                const message: ManagedAgentLauncherClientMessage = {
                    type: 'exited',
                    exitCode,
                    signal,
                };
                if (!didWriteMessage(socket, message)) failClosed();
                else socket.setTimeout(5_000, failClosed);
            });
        };

        socket.setEncoding('utf8');
        process.on('SIGINT', forwardSigint);
        process.on('SIGHUP', forwardSighup);
        process.on('SIGTERM', forwardSigterm);
        socket.setTimeout(5_000, failClosed);
        socket.once('connect', () => {
            if (
                !didWriteMessage(socket, {
                    type: 'claim',
                    launchId: options.launchId,
                    token,
                })
            ) {
                failClosed();
            }
        });
        socket.on('data', (chunk: string) => {
            if (isTransportFailed) return;
            let values: Array<{ value: unknown; byteLength: number }>;
            try {
                values = decoder.push(chunk);
            } catch {
                failClosed();
                return;
            }
            for (const decoded of values) {
                if (!isPlanReceived) {
                    isPlanReceived = true;
                    socket.setTimeout(0);
                    startChild(decoded.value);
                    try {
                        decoder.setMaxBytes(MAX_MANAGED_AGENT_LAUNCHER_CONTROL_BYTES);
                    } catch {
                        failClosed();
                        return;
                    }
                    continue;
                }
                try {
                    if (decoded.byteLength > MAX_MANAGED_AGENT_LAUNCHER_CONTROL_BYTES)
                        throw launcherFailure();
                    const control = parseManagedAgentLauncherServerMessage(decoded.value);
                    if (control.type === 'exitAck') {
                        if (!isChildExited || !pendingExit) {
                            failClosed();
                            return;
                        }
                        isExitAcknowledged = true;
                        settleAfterDrain(undefined, pendingExit);
                        continue;
                    }
                    if (!child || isChildExited) {
                        failClosed();
                        return;
                    }
                    if (control.type === 'cancel') terminateChild();
                    else child.kill(control.signal);
                } catch {
                    failClosed();
                    return;
                }
            }
        });
        socket.once('end', () => {
            try {
                decoder.finish();
            } catch {
                failClosed();
                return;
            }
            if (!isChildExited) failClosed();
            else if (isExitAcknowledged && isDrainingAfterExit && pendingExit)
                settle(undefined, pendingExit);
        });
        socket.once('error', failClosed);
        socket.once('close', () => {
            if (!isSettled) failClosed();
        });
    });
}
