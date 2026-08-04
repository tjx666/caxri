import { runInElectron } from './run-in-electron.ts';

if (!(await runInElectron(import.meta.url))) {
    const [{ default: Database }, pty, { app }] = await Promise.all([
        import('better-sqlite3'),
        import('node-pty'),
        import('electron'),
    ]);
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
            sqlite: sqliteVersion,
        })}\n`,
    );
    app.quit();
}
