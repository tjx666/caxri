#!/usr/bin/env bun

import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { build } from 'vite';

import { ArtifactRefreshCoordinator } from './watch-coordinator';

const execFileAsync = promisify(execFile);
const serverRoot = resolve(import.meta.dirname, '..');

type ServerWatchEvent = { code: 'END' } | { code: 'ERROR'; error: unknown } | { code: string };

interface ViteServerBuildWatcher {
    close(): Promise<void>;
    on(event: 'event', listener: (event: ServerWatchEvent) => void): void;
}

function isServerBuildWatcher(value: unknown): value is ViteServerBuildWatcher {
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

const coordinator = new ArtifactRefreshCoordinator({
    watcher,
    refreshArtifact: async () => {
        const { stderr, stdout } = await execFileAsync(
            process.execPath,
            ['run', resolve(serverRoot, 'scripts/build-artifact.ts')],
            { cwd: serverRoot },
        );
        if (stderr) process.stderr.write(stderr);
        process.stdout.write(stdout);
    },
    /**
     * Signals readiness only after the first artifact build and verification have completed.
     */
    reportReady: async () => {
        const readyPath = process.env.CAXRI_SERVER_WATCH_READY_FILE;
        if (readyPath) await writeFile(readyPath, 'ready\n', { mode: 0o600 });
    },
});
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
