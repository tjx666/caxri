import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { resolveServerArtifact } from '@caxri/client/supervise';

import { execFileAsync } from './exec';

/**
 * Runs inside the artifact's Node process, rather than Bun, so the compatibility gate exercises the shipped binding. A
 * successful subscription does not prove that the OS is delivering events to that binding.
 */

export const nativeWatchProbeSource = `
async function subscribeAndVerifyWatcher(watcher, root, timeoutMs = 5000) {
    const { realpath, writeFile } = require('node:fs/promises');
    const { join } = require('node:path');
    const canonicalRoot = await realpath(root);
    const target = join(canonicalRoot, 'watcher-delivery-probe.txt');
    let observed = false;
    let failed = false;
    const subscription = await watcher.subscribe(canonicalRoot, (error, events) => {
        if (error) failed = true;
        if (events.some((event) => event.path === target)) observed = true;
    }, { backend: process.platform === 'darwin' ? 'fs-events' : process.platform === 'win32' ? 'windows' : 'inotify' });
    try {
        await writeFile(target, 'fixture');
        const deadline = Date.now() + timeoutMs;
        while (!observed && !failed && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        if (failed) throw new Error('Native watcher reported an error during the delivery probe');
        if (!observed) throw new Error('Native watcher subscribed but delivered no probe event');
        return subscription;
    } catch (error) {
        await subscription.unsubscribe();
        throw error;
    }
}
`;

const nativeProbe = String.raw`
${nativeWatchProbeSource}
const { createRequire } = require('node:module');
const artifactNativeRoot = process.argv[1];
const watcherRoot = process.argv[2];
const requireFromArtifact = createRequire(artifactNativeRoot + '/probe.cjs');

(async () => {
    const Database = requireFromArtifact('better-sqlite3');
    const watcher = requireFromArtifact('@parcel/watcher');
    const pty = requireFromArtifact('node-pty');
    const subscription = await subscribeAndVerifyWatcher(watcher, watcherRoot);
    try {
        const database = new Database(':memory:');
        const sqliteVersion = database.prepare('select sqlite_version() as version').get().version;
        database.close();

        const terminal = pty.spawn('/bin/sh', ['-lc', 'printf caxri-pty-ok'], {
            cols: 80,
            cwd: watcherRoot,
            env: process.env,
            name: 'xterm-256color',
            rows: 24,
        });
        let terminalOutput = '';
        terminal.onData((data) => {
            terminalOutput += data;
        });
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('PTY probe timed out')), 5_000);
            terminal.onExit(({ exitCode }) => {
                clearTimeout(timeout);
                if (exitCode === 0) resolve();
                else reject(new Error('PTY probe exited with ' + exitCode));
            });
        });
        if (!terminalOutput.includes('caxri-pty-ok')) throw new Error('PTY output was incomplete');

        process.stdout.write(JSON.stringify({
            architecture: process.arch,
            modulesAbi: process.versions.modules,
            nodePty: 'spawned',
            parcelWatcher: 'event-delivered',
            runtime: process.versions.node,
            sqlite: sqliteVersion,
        }) + '\n');
    } finally {
        await subscription.unsubscribe();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
`;

async function main(): Promise<void> {
    const artifact = await resolveServerArtifact(resolve('apps/server/dist/server'));
    const watcherRoot = await mkdtemp(join(tmpdir(), 'caxri-native-spike-'));
    try {
        const { stderr, stdout } = await execFileAsync(
            artifact.executablePath,
            ['-e', nativeProbe, resolve(artifact.rootPath, 'native'), watcherRoot],
            { timeout: 15_000 },
        );
        if (stderr) process.stderr.write(stderr);
        process.stdout.write(stdout);
    } finally {
        await rm(watcherRoot, { recursive: true, force: true });
    }
}

if (import.meta.main) await main();
