import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it, onTestFinished } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../connection';
import { CaxriDatabase } from '../index';
import { createDatabaseBeforeMigration } from './pre-migration.fixture';

describe('0001_terminal_surface migration', () => {
    it('upgrades a baseline database in place, keeping Terminals, snapshots, and the Primary Agent', async () => {
        const terminalId = 'terminal-1';
        const sessionId = 'session-1';
        // The baseline had no `surface` column, so the seed writes only columns that existed then.
        const { path: databasePath } = await createDatabaseBeforeMigration(
            '0001_terminal_surface',
            (raw) => {
                raw.prepare(
                    "INSERT INTO projects (id, root_path, display_title, created_at, last_opened_at) VALUES ('project-1', '/tmp/caxri-seed-project', 'project', 1, 1)",
                ).run();
                raw.prepare(
                    "INSERT INTO sessions (id, project_id, created_at, last_opened_at, last_session_activity_at, display_title) VALUES (?, 'project-1', 1, 1, 1, 'session')",
                ).run(sessionId);
                raw.prepare(
                    "INSERT INTO terminals (id, session_id, kind, provider, cwd, title, icon, order_index, last_process_state, created_at, updated_at) VALUES (?, ?, 'codex', 'codex', '/tmp/caxri-seed-project', 'codex', 'bot', 0, 'stopped', 1, 1)",
                ).run(terminalId, sessionId);
                raw.prepare('UPDATE sessions SET primary_agent_terminal_id = ? WHERE id = ?').run(
                    terminalId,
                    sessionId,
                );
                raw.prepare(
                    "INSERT INTO terminal_snapshots (terminal_id, encoding_version, cols, rows, line_count, byte_count, payload, updated_at) VALUES (?, 1, 80, 24, 1, 2, 'hi', 1)",
                ).run(terminalId);
            },
        );
        const terminal = { id: terminalId };
        const session = { id: sessionId };

        const upgraded = new CaxriDatabase(databasePath);
        onTestFinished(() => upgraded.close());

        expect(upgraded.getTerminal(terminal.id)).toMatchObject({
            id: terminal.id,
            kind: 'codex',
        });
        expect(upgraded.getTerminal(terminal.id)).not.toHaveProperty('surface');
        expect(upgraded.getSession(session.id)?.primaryAgentTerminalId).toBe(terminal.id);
        expect(upgraded.getSnapshot(terminal.id)?.payload).toBe('hi');
        const check = new Database(databasePath, { readonly: true });
        expect(check.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
        expect(check.prepare('SELECT surface FROM terminals').all()).toEqual([{ surface: 'pty' }]);
        check.close();
    });

    it('round-trips a Chat Terminal', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-db-surface-'));
        onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const database = new CaxriDatabase(join(directory, 'state.db'));
        onTestFinished(() => database.close());
        const project = database.createProject(join(directory, 'project'));
        const { session } = database.createSession(project.id, null);
        const chat = database.createTerminal(session.id, 'codex', undefined, 'chat');
        expect(chat.surface).toBe('chat');
        expect(database.getTerminal(chat.id)?.surface).toBe('chat');
        expect(database.getSession(session.id)?.primaryAgentTerminalId).toBe(chat.id);
    });
});
