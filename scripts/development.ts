#!/usr/bin/env bun

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { developmentCommands } from './development-commands';

const SERVER_WATCH_READY_POLL_MS = 25;
const SERVER_WATCH_READY_TIMEOUT_MS = 5 * 60_000;

function resolveServerWatchReadyTimeout(): number {
    const configured = process.env.CAXRI_SERVER_WATCH_READY_TIMEOUT_MS;
    if (!configured) return SERVER_WATCH_READY_TIMEOUT_MS;
    const timeout = Number(configured);
    if (!Number.isSafeInteger(timeout) || timeout <= 0) {
        throw new Error('CAXRI_SERVER_WATCH_READY_TIMEOUT_MS must be a positive integer');
    }
    return timeout;
}

class DevelopmentProcesses {
    readonly #children: Array<ReturnType<typeof spawn>> = [];
    #isClosing = false;
    readonly #serverReadyPath = join(
        tmpdir(),
        `caxri-server-watch-${process.pid}-${randomUUID()}.ready`,
    );

    constructor() {
        const [serverCommand] = developmentCommands;
        const server = this.#spawn(serverCommand, {
            CAXRI_SERVER_WATCH_READY_FILE: this.#serverReadyPath,
        });
        // eslint-disable-next-line unicorn/prefer-await -- constructors cannot await the child-owned readiness barrier
        this.#startDesktopWhenServerIsReady(server).catch((error: unknown) => {
            console.error(error);
            this.close('SIGTERM', 1);
        });
    }

    #spawn(
        [command, ...arguments_]: (typeof developmentCommands)[number],
        environment?: NodeJS.ProcessEnv,
    ): ReturnType<typeof spawn> {
        const child = spawn(command, arguments_, {
            env: environment ? { ...process.env, ...environment } : process.env,
            stdio: 'inherit',
        });
        this.#children.push(child);
        child.once('error', (error) => {
            console.error(error);
            this.close('SIGTERM', 1);
        });
        child.once('exit', (exitCode, signal) => {
            if (this.#isClosing) return;
            this.close('SIGTERM', exitCode ?? (signal ? 1 : 0));
        });
        return child;
    }

    #canStartDesktop(): boolean {
        return !this.#isClosing;
    }

    /**
     * The watcher removes and reassembles the live Server artifact during its first build. Wait for its
     * verified-artifact marker so Desktop cannot validate that directory while it is incomplete.
     */
    async #startDesktopWhenServerIsReady(server: ReturnType<typeof spawn>): Promise<void> {
        const timeout = resolveServerWatchReadyTimeout();
        const deadline = Date.now() + timeout;
        console.log('Waiting for the initial Server artifact to be ready...');
        try {
            while (!this.#isClosing && server.exitCode === null && server.signalCode === null) {
                try {
                    // eslint-disable-next-line no-await-in-loop -- the watcher publishes readiness asynchronously
                    await readFile(this.#serverReadyPath);
                    if (this.#canStartDesktop()) this.#spawn(developmentCommands[1]);
                    return;
                } catch (error) {
                    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
                        throw error;
                    }
                }
                if (Date.now() >= deadline) {
                    throw new Error(
                        `Timed out after ${timeout} ms waiting for the initial Server artifact`,
                    );
                }
                // eslint-disable-next-line no-await-in-loop -- the child-owned readiness file is a bounded local barrier
                await new Promise((resolve) => setTimeout(resolve, SERVER_WATCH_READY_POLL_MS));
            }
        } finally {
            await rm(this.#serverReadyPath, { force: true });
        }
    }

    async #exitAfterChildren(exitCode: number): Promise<void> {
        try {
            await Promise.all(
                this.#children.map(
                    (child) =>
                        new Promise<void>((resolve) => {
                            if (child.exitCode !== null || child.signalCode !== null)
                                return resolve();
                            child.once('exit', () => resolve());
                        }),
                ),
            );
        } finally {
            process.exit(exitCode);
        }
    }

    /**
     * Force `process.exit` after signalling the children. Setting `process.exitCode` alone leaves this launcher (and by
     * extension every child that missed the signal) alive whenever any handle keeps the event loop running. Give the
     * children a bounded grace period so they can flush their own shutdown, then hard-exit regardless.
     */
    close(signal: NodeJS.Signals, exitCode: number): void {
        if (this.#isClosing) return;
        this.#isClosing = true;
        for (const child of this.#children) {
            if (child.exitCode === null && child.signalCode === null) child.kill(signal);
        }
        process.exitCode = exitCode;
        const forceExit = setTimeout(() => process.exit(exitCode), 5000);
        forceExit.unref();
        void this.#exitAfterChildren(exitCode);
    }
}

const development = new DevelopmentProcesses();
process.once('SIGINT', () => development.close('SIGINT', 0));
process.once('SIGTERM', () => development.close('SIGTERM', 0));
process.once('SIGHUP', () => development.close('SIGTERM', 0));
