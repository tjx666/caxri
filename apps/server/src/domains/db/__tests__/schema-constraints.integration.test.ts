import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CaxriDatabaseConnection as CaxriDatabase } from '../index';

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

describe('schema CHECK constraints', () => {
    it('rejects Terminal and Session states outside their protocol enums', async () => {
        const directory = await temporaryDirectory('caxri-db-check-');
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

        expect(() =>
            database.database
                .prepare("UPDATE terminals SET last_process_state = 'zombie' WHERE id = ?")
                .run(terminal.id),
        ).toThrow(/CHECK constraint failed: terminals_last_process_state/);
        expect(() =>
            database.database
                .prepare("UPDATE terminals SET failure_reason = 'spawn_failed' WHERE id = ?")
                .run(terminal.id),
        ).toThrow(/CHECK constraint failed: terminals_failure_reason_state/);
        expect(() =>
            database.database
                .prepare("UPDATE sessions SET title_mode = 'locked' WHERE id = ?")
                .run(session.id),
        ).toThrow(/CHECK constraint failed: sessions_title_mode/);
        database.close();
    });

    it('rejects Caxri Bot rows whose columns contradict their kind or status', async () => {
        const directory = await temporaryDirectory('caxri-db-bot-check-');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const run = (statement: string) => () => database.database.prepare(statement).run();

        expect(
            run(
                "INSERT INTO bot_inbox_items (id, kind, status, title, body, created_at, updated_at) VALUES ('a', 'decision', 'closed', 't', 'b', 1, 1)",
            ),
        ).toThrow(/CHECK constraint failed: bot_inbox_closed_state/);
        expect(
            run(
                "INSERT INTO bot_inbox_items (id, kind, status, close_reason, title, body, created_at, updated_at, closed_at) VALUES ('b', 'decision', 'open', 'resolved', 't', 'b', 1, 1, 1)",
            ),
        ).toThrow(/CHECK constraint failed: bot_inbox_closed_state/);
        expect(
            run(
                "INSERT INTO bot_pending_notices (key, kind, delegation_id, queued_at) VALUES ('d', 'delegation', 'delegation-1', 1)",
            ),
        ).toThrow(/CHECK constraint failed: bot_pending_notices_shape/);
        expect(
            run(
                "INSERT INTO bot_pending_notices (key, kind, revision, queued_at) VALUES ('i', 'interrupted_turn', 1, 1)",
            ),
        ).toThrow(/CHECK constraint failed: bot_pending_notices_shape/);
        expect(
            run(
                "INSERT INTO claude_window_schedules (account_hash, keep_rolling, updated_at) VALUES ('h', 2, 1)",
            ),
        ).toThrow(/CHECK constraint failed: claude_window_schedules_keep_rolling/);
        database.close();
    });
});
