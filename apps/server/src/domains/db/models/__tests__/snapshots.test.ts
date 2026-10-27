import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TerminalSnapshot } from '@caxri/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { CaxriDatabaseConnection as CaxriDatabase } from '../../index';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const directoriesToRemove = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(
        directoriesToRemove.map((path) => rm(path, { recursive: true, force: true })),
    );
});

async function temporaryDirectory(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
}

/**
 * `terminal_snapshots.terminal_id` is a foreign key onto `terminals.id`, so every fixture below needs one real
 * Project/Session/Terminal chain rather than an arbitrary string id.
 */
async function openDatabaseWithTerminal(
    prefix: string,
): Promise<{ database: CaxriDatabase; terminalId: string }> {
    const directory = await temporaryDirectory(prefix);
    const root = join(directory, 'project');
    await mkdir(root);
    const database = new CaxriDatabase(join(directory, 'state.db'));
    const project = database.projects.create(root);
    const session = database.sessions.insert({ projectId: project.id, title: 'Shell' });
    const terminal = database.terminals.insert({
        sessionId: session.id,
        kind: 'shell',
        cwd: root,
        title: 'Shell',
    });
    return { database, terminalId: terminal.id };
}

function makeSnapshot(
    terminalId: string,
    overrides: Partial<TerminalSnapshot> = {},
): TerminalSnapshot {
    return {
        terminalId,
        encodingVersion: 1,
        cols: 80,
        rows: 24,
        lineCount: 3,
        byteCount: 24,
        payload: 'restored-buffer',
        updatedAt: Date.now(),
        ...overrides,
    };
}

describe('SnapshotsModel', () => {
    it('round-trips a saved snapshot', async () => {
        const { database, terminalId } = await openDatabaseWithTerminal(
            'caxri-snapshot-round-trip-',
        );
        const snapshot = makeSnapshot(terminalId);

        database.snapshots.save(snapshot);

        expect(database.snapshots.get(terminalId)).toEqual(snapshot);
        database.close();
    });

    it('overwrites the existing snapshot for the same Terminal instead of duplicating it', async () => {
        const { database, terminalId } = await openDatabaseWithTerminal(
            'caxri-snapshot-overwrite-',
        );
        database.snapshots.save(
            makeSnapshot(terminalId, { payload: 'first-buffer', updatedAt: 1 }),
        );

        const second = makeSnapshot(terminalId, {
            encodingVersion: 2,
            lineCount: 5,
            byteCount: 40,
            payload: 'second-buffer',
            updatedAt: 2,
        });
        database.snapshots.save(second);

        expect(database.snapshots.get(terminalId)).toEqual(second);
        expect(
            (
                database.database
                    .prepare(
                        'SELECT COUNT(*) AS count FROM terminal_snapshots WHERE terminal_id = ?',
                    )
                    .get(terminalId) as { count: number }
            ).count,
        ).toBe(1);
        database.close();
    });

    it('returns undefined for a Terminal that has no stored snapshot', async () => {
        const { database, terminalId } = await openDatabaseWithTerminal('caxri-snapshot-missing-');

        expect(database.snapshots.get(terminalId)).toBeUndefined();
        expect(database.snapshots.get('unknown-terminal')).toBeUndefined();
        database.close();
    });

    it('imposes no payload size bound in the model itself', async () => {
        const { database, terminalId } = await openDatabaseWithTerminal('caxri-snapshot-size-');
        const largePayload = 'x'.repeat(200_000);
        const snapshot = makeSnapshot(terminalId, {
            payload: largePayload,
            byteCount: largePayload.length,
        });

        database.snapshots.save(snapshot);

        expect(database.snapshots.get(terminalId)?.payload).toHaveLength(largePayload.length);
        database.close();
    });

    it('rejects a snapshot for a Terminal id that does not exist', async () => {
        const { database } = await openDatabaseWithTerminal('caxri-snapshot-fk-');

        expect(() => database.snapshots.save(makeSnapshot('does-not-exist'))).toThrow(
            /FOREIGN KEY constraint failed/,
        );
        database.close();
    });

    it('cascades deletion when the owning Terminal closes', async () => {
        const { database, terminalId } = await openDatabaseWithTerminal('caxri-snapshot-cascade-');
        database.snapshots.save(makeSnapshot(terminalId));
        expect(database.snapshots.get(terminalId)).toBeDefined();

        database.terminals.remove(terminalId);

        expect(database.snapshots.get(terminalId)).toBeUndefined();
        database.close();
    });
});
