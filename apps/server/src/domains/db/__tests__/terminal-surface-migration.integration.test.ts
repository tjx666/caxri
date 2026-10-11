import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it, onTestFinished } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../connection';
import { CaxriDatabase } from '../index';
import { BASELINE_SCHEMA_VERSION } from '../migrations/manifest';

describe('0001_terminal_surface migration', () => {
    it('upgrades a baseline database in place, keeping Terminals, snapshots, and the Primary Agent', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-db-surface-'));
        onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const databasePath = join(directory, 'state.db');
        const previous = new CaxriDatabase(databasePath);
        const project = previous.createProject(join(directory, 'project'));
        const { session, terminal } = previous.createSession(project.id, 'codex');
        previous.saveSnapshot({
            terminalId: terminal!.id,
            encodingVersion: 1,
            cols: 80,
            rows: 24,
            lineCount: 1,
            byteCount: 2,
            payload: 'hi',
            updatedAt: 1,
        });
        previous.close();
        // Reproduce the schema-39 layout: the baseline had no `surface` column and none of the later tables.
        const raw = new Database(databasePath);
        raw.exec(
            'DROP TABLE agent_session_usage; DROP TABLE pull_request_outcomes; DROP TABLE external_agent_usage; DROP TABLE commander_tasks; DROP TABLE commander_pending_notices; DROP TABLE commander_inbox_replies; DROP TABLE commander_inbox_items',
        );
        raw.exec('ALTER TABLE terminals DROP COLUMN surface');
        raw.exec(
            'ALTER TABLE projects DROP COLUMN chat_defaults; ALTER TABLE terminals DROP COLUMN chat_permission_mode; ALTER TABLE terminals DROP COLUMN chat_plan_mode',
        );
        raw.pragma(`user_version = ${BASELINE_SCHEMA_VERSION}`);
        raw.close();

        const upgraded = new CaxriDatabase(databasePath);
        onTestFinished(() => upgraded.close());

        expect(upgraded.getTerminal(terminal!.id)).toMatchObject({
            id: terminal!.id,
            kind: 'codex',
        });
        expect(upgraded.getTerminal(terminal!.id)).not.toHaveProperty('surface');
        expect(upgraded.getSession(session.id)?.primaryAgentTerminalId).toBe(terminal!.id);
        expect(upgraded.getSnapshot(terminal!.id)?.payload).toBe('hi');
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
