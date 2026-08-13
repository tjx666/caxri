import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runInElectron } from './run-in-electron.ts';

if (!(await runInElectron(import.meta.url))) {
    const [{ default: Database }, watcher, pty, { app }] = await Promise.all([
        import('better-sqlite3'),
        import('@parcel/watcher'),
        import('node-pty'),
        import('electron'),
    ]);
    const watcherRoot = await mkdtemp(join(tmpdir(), 'caxri-native-spike-'));
    let subscription: Awaited<ReturnType<typeof watcher.subscribe>> | undefined;

    try {
        subscription = await watcher.subscribe(watcherRoot, () => undefined);
        const database = new Database(':memory:');
        const sqliteVersion = (
            database.prepare('select sqlite_version() as version').get() as { version: string }
        ).version;
        database.close();

        if (typeof pty.spawn !== 'function') throw new Error('node-pty did not expose spawn()');

        process.stdout.write(
            `${JSON.stringify({
                architecture: process.arch,
                electron: process.versions.electron,
                modulesAbi: process.versions.modules,
                node: process.versions.node,
                nodePty: 'loaded',
                parcelWatcher: 'loaded',
                sqlite: sqliteVersion,
            })}\n`,
        );
    } finally {
        await subscription?.unsubscribe();
        await rm(watcherRoot, { recursive: true, force: true });
        app.quit();
    }
}
