#!/usr/bin/env bun

import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { build } from 'vite';

const execFileAsync = promisify(execFile);
const serverRoot = resolve(import.meta.dirname, '..');

type ServerWatchEvent = { code: 'END' } | { code: 'ERROR'; error: unknown } | { code: string };

interface ServerBuildWatcher {
    close(): Promise<void>;
    on(event: 'event', listener: (event: ServerWatchEvent) => void): void;
}

function isServerBuildWatcher(value: unknown): value is ServerBuildWatcher {
    if (typeof value !== 'object' || value === null) return false;
    return (
        typeof Reflect.get(value, 'close') === 'function' &&
        typeof Reflect.get(value, 'on') === 'function'
    );
}

const buildResult = await build({
    build: { watch: {} },
    configFile: resolve(serverRoot, 'vite.config.ts'),
});

if (!isServerBuildWatcher(buildResult)) {
    throw new Error('Server watch build did not return a watcher');
}
const watcher = buildResult;

class ArtifactRefreshCoordinator {
    readonly #watcher = watcher;
    #isClosing = false;
    #isRefreshing = false;
    #needsRefresh = false;

    async close(exitCode: number): Promise<void> {
        if (this.#isClosing) return;
        this.#isClosing = true;
        this.#needsRefresh = false;
        await this.#watcher.close();
        process.exitCode = exitCode;
    }

    async refresh(): Promise<void> {
        this.#needsRefresh = true;
        if (this.#isRefreshing || this.#isClosing) return;
        this.#isRefreshing = true;
        try {
            while (this.#needsRefresh) {
                this.#needsRefresh = false;
                // eslint-disable-next-line no-await-in-loop -- coalesced rebuilds must publish artifacts in source order
                const { stderr, stdout } = await execFileAsync(
                    process.execPath,
                    ['run', resolve(serverRoot, 'scripts/build-artifact.ts')],
                    { cwd: serverRoot },
                );
                if (stderr) process.stderr.write(stderr);
                process.stdout.write(stdout);
            }
        } finally {
            this.#isRefreshing = false;
        }
    }
}

const coordinator = new ArtifactRefreshCoordinator();
watcher.on('event', async (event) => {
    if (event.code === 'ERROR') {
        console.error(event.error);
        await coordinator.close(1);
        return;
    }
    if (event.code !== 'END') return;
    try {
        await coordinator.refresh();
    } catch (error) {
        console.error(error);
        await coordinator.close(1);
    }
});

process.once('SIGINT', async () => coordinator.close(0));
process.once('SIGTERM', async () => coordinator.close(0));
