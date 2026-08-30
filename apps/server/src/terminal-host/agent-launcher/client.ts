import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
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
        let isPlanReceived = false;
        let isSettled = false;
        let isTransportFailed = false;
        let pendingExit: ManagedAgentLauncherExit | undefined;
        let forwardSigint: () => void = () => {};
        let forwardSighup: () => void = () => {};
        let forwardSigterm: () => void = () => {};

        const settle = (error: Error | undefined, exit?: ManagedAgentLauncherExit): void => {
            if (isSettled) return;
            isSettled = true;
            if (forceKillTimer) clearTimeout(forceKillTimer);
            process.off('SIGINT', forwardSigint);
            process.off('SIGHUP', forwardSighup);
            process.off('SIGTERM', forwardSigterm);
            if (error) reject(error);
            else if (exit) resolve(exit);
            else reject(launcherFailure());
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
            else settle(launcherFailure());
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
            child.once('error', () => {
                if (!child?.pid) {
                    isChildExited = true;
                    socket.destroy();
                    settle(launcherFailure());
                    return;
                }
                failClosed();
            });
            child.once('exit', (exitCode, signal) => {
                isChildExited = true;
                if (forceKillTimer) clearTimeout(forceKillTimer);
                const exit: ManagedAgentLauncherExit = { exitCode, signal };
                pendingExit = exit;
                if (isTransportFailed) {
                    settle(launcherFailure());
                    return;
                }
                if (socket.destroyed || !socket.writable) {
                    settle(launcherFailure());
                    return;
                }
                const message: ManagedAgentLauncherClientMessage = {
                    type: 'exited',
                    exitCode,
                    signal,
                };
                socket.end(encodeJsonLine(message, MAX_MANAGED_AGENT_LAUNCHER_CONTROL_BYTES), () =>
                    settle(undefined, exit),
                );
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
                if (!child || isChildExited) {
                    failClosed();
                    return;
                }
                try {
                    if (decoded.byteLength > MAX_MANAGED_AGENT_LAUNCHER_CONTROL_BYTES)
                        throw launcherFailure();
                    const control = parseManagedAgentLauncherServerMessage(decoded.value);
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
        });
        socket.once('error', failClosed);
        socket.once('close', () => {
            if (!isChildExited) failClosed();
            else if (!isTransportFailed && pendingExit) settle(undefined, pendingExit);
        });
    });
}
