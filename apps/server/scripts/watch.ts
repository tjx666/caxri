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
/**
 * `coordinator.close()` only awaits the Vite watcher and sets `process.exitCode`; it never calls `process.exit()`. Any
 * lingering handle (an in-flight artifact build, an unreleased chokidar watch) then keeps the event loop alive forever,
 * orphaning this process after its parent exits. Force the exit here, with a bounded fallback in case `close()` itself
 * never resolves.
 */
const SHUTDOWN_TIMEOUT_MS = 5000;

async function shutdown(exitCode: number): Promise<void> {
    const forceExit = setTimeout(() => process.exit(exitCode), SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();
    await coordinator.close(exitCode);
    process.exit(exitCode);
}

watcher.on('event', async (event) => {
    if (event.code === 'ERROR') {
        console.error(event.error);
        await shutdown(1);
        return;
    }
    if (event.code !== 'END') return;
    try {
        await coordinator.refresh();
    } catch (error) {
        console.error(error);
        await shutdown(1);
    }
});

process.once('SIGINT', () => shutdown(0));
process.once('SIGTERM', () => shutdown(0));
process.once('SIGHUP', () => shutdown(0));

/**
 * Parent-death detector. When the parent (`scripts/development.ts`) is killed with SIGKILL, OOMs, or the terminal
 * window is closed without the SIGHUP reaching us, no signal ever arrives here and the watcher lingers forever as an
 * orphan. Poll `ppid`: once it reads 1 we have been reparented to init, so exit ourselves. macOS has no
 * `PR_SET_PDEATHSIG`, so polling is the portable option.
 */
const ORPHAN_CHECK_INTERVAL_MS = 3000;
const initialPpid = process.ppid;
async function shutdownIfOrphaned(): Promise<void> {
    const currentPpid = process.ppid;
    if (currentPpid === initialPpid || currentPpid > 1) return;
    console.error('watch.ts: parent process exited, shutting down');
    try {
        await shutdown(0);
    } catch {
        process.exit(0);
    }
}

const orphanCheck = setInterval(() => {
    void shutdownIfOrphaned();
}, ORPHAN_CHECK_INTERVAL_MS);
orphanCheck.unref();
