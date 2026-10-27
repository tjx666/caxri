import { chmodSync } from 'node:fs';

import Database from 'better-sqlite3';

/**
 * Where the pre-rebuild copy of `databasePath` goes: beside it, named after the schema version it holds and the moment
 * it was taken, so a later rebuild never overwrites an earlier copy.
 */
function rebuildBackupPath(databasePath: string, version: number, now: Date): string {
    const stamp = now
        .toISOString()
        .replaceAll(/[-:]/gu, '')
        .replace(/\.\d+Z$/u, 'Z');
    return `${databasePath}.v${version}-${stamp}.bak`;
}

/**
 * Copies a database the clean-install cutoff is about to rebuild, so the dropped Projects and Sessions stay recoverable
 * by hand. `VACUUM INTO` writes one consistent snapshot that includes every committed WAL frame, which a plain file
 * copy of a WAL database would miss, and refuses to replace an existing file. The copy is reopened and must report the
 * same schema version; any failure throws, and the caller then leaves the database untouched instead of rebuilding it.
 */
export function backupBeforeRebuild(
    database: Database.Database,
    databasePath: string,
    version: number,
    now = new Date(),
): string {
    const backupPath = rebuildBackupPath(databasePath, version, now);
    database.prepare('VACUUM INTO ?').run(backupPath);
    // oxlint-disable-next-line node/no-sync -- runs on the synchronous database open path, like `restrictPath`.
    chmodSync(backupPath, 0o600);
    const copy = new Database(backupPath, { readonly: true, fileMustExist: true });
    try {
        const copied = copy.pragma('user_version', { simple: true }) as number;
        if (copied !== version)
            throw new Error(
                `The database backup at ${backupPath} reports schema version ${copied}, not ${version}`,
            );
    } finally {
        copy.close();
    }
    return backupPath;
}
