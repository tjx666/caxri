#!/usr/bin/env bun

import { spawn } from 'node:child_process';
import process from 'node:process';

const commands = [
    ['pnpm', '--filter', '@caxri/server', 'run', 'dev'],
    ['electron-vite', 'dev'],
] as const;

class DevelopmentProcesses {
    readonly #children = commands.map(([command, ...arguments_]) =>
        spawn(command, arguments_, { stdio: 'inherit' }),
    );
    #isClosing = false;

    constructor() {
        for (const child of this.#children) {
            child.once('error', (error) => {
                console.error(error);
                this.close('SIGTERM', 1);
            });
            child.once('exit', (exitCode, signal) => {
                if (this.#isClosing) return;
                this.close('SIGTERM', exitCode ?? (signal ? 1 : 0));
            });
        }
    }

    close(signal: NodeJS.Signals, exitCode: number): void {
        if (this.#isClosing) return;
        this.#isClosing = true;
        for (const child of this.#children) {
            if (child.exitCode === null && child.signalCode === null) child.kill(signal);
        }
        process.exitCode = exitCode;
    }
}

const development = new DevelopmentProcesses();
process.once('SIGINT', () => development.close('SIGINT', 0));
process.once('SIGTERM', () => development.close('SIGTERM', 0));
