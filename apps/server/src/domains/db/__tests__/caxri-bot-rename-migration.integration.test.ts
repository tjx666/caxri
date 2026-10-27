import Database from 'better-sqlite3';
import { describe, expect, it, onTestFinished } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../connection';
import { CaxriDatabase } from '../index';
import { BASELINE_SCHEMA_VERSION } from '../migrations/manifest';
import { createDatabaseBeforeMigration, seedSessionWithChat } from './pre-migration.fixture';

describe('Caxri Bot rename migrations', () => {
    it('keeps the former Agent Commander rows and app_state cells across 0013_caxri_bot_rename', async () => {
        let ids = { projectId: '', sessionId: '', terminalId: '' };
        const { path } = await createDatabaseBeforeMigration('0013_caxri_bot_rename', (raw) => {
            ids = seedSessionWithChat(raw, 'codex');
            raw.prepare(
                "INSERT INTO commander_tasks (id, title, status, project_id, session_id, created_at, updated_at) VALUES ('task-1', 'Fix login', 'dispatched', ?, ?, 1, 2)",
            ).run(ids.projectId, ids.sessionId);
            raw.exec(
                "INSERT INTO commander_inbox_items (id, kind, dedup_key, status, title, body, created_at, updated_at) VALUES ('item-1', 'decision', 'key-1', 'open', 'Pick one', 'Which?', 1, 1)",
            );
            raw.exec(
                "INSERT INTO commander_inbox_replies (item_id, sequence, body, source, created_at) VALUES ('item-1', 1, 'The first', 'desktop', 2)",
            );
            raw.exec(
                "INSERT INTO commander_pending_notices (key, kind, delegation_id, status, revision, queued_at) VALUES ('notice-1', 'delegation', 'delegation-1', 'completed', 1, 3)",
            );
            const setAppState = raw.prepare(
                'INSERT INTO app_state (key, value_json) VALUES (?, ?)',
            );
            setAppState.run(
                'agentCommander',
                JSON.stringify({
                    projectId: ids.projectId,
                    sessionId: ids.sessionId,
                    terminalId: ids.terminalId,
                    sessionIds: [],
                }),
            );
            setAppState.run('commanderAgent', JSON.stringify('claude'));
            setAppState.run('commanderHandovers', JSON.stringify([]));
            setAppState.run(
                'auxiliaryWindowState',
                JSON.stringify({
                    agentCommander: {
                        bounds: { x: 10, y: 20, width: 900, height: 700 },
                        wasOpenAtQuit: true,
                    },
                    processExplorer: {},
                }),
            );
        });

        const upgraded = new CaxriDatabase(path);
        onTestFinished(() => upgraded.close());
        expect(upgraded.botTasks.get('task-1')).toMatchObject({
            title: 'Fix login',
            status: 'dispatched',
            projectId: ids.projectId,
            sessionId: ids.sessionId,
        });
        expect(upgraded.botInbox.get('item-1')).toMatchObject({
            kind: 'decision',
            title: 'Pick one',
        });
        expect(upgraded.getAppState('caxriBot')).toEqual({
            projectId: ids.projectId,
            sessionId: ids.sessionId,
            terminalId: ids.terminalId,
            sessionIds: [],
        });
        expect(upgraded.getAppState('botAgent')).toBe('claude');
        expect(upgraded.getAppState('botHandovers')).toEqual([]);
        expect(upgraded.getAppState('auxiliaryWindowState')).toEqual({
            caxriBot: { bounds: { x: 10, y: 20, width: 900, height: 700 }, wasOpenAtQuit: true },
            processExplorer: {},
        });

        const check = new Database(path, { readonly: true });
        onTestFinished(() => {
            check.close();
        });
        expect(check.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
        expect(
            check
                .prepare(
                    "SELECT name FROM sqlite_master WHERE name LIKE 'commander%' ORDER BY name",
                )
                .all(),
        ).toEqual([]);
        expect(check.prepare('SELECT body FROM bot_inbox_replies').all()).toEqual([
            { body: 'The first' },
        ]);
        expect(check.prepare('SELECT key FROM bot_pending_notices').all()).toEqual([
            { key: 'notice-1' },
        ]);
        expect(
            check
                .prepare(
                    "SELECT key FROM app_state WHERE key IN ('agentCommander', 'commanderAgent', 'commanderHandovers')",
                )
                .all(),
        ).toEqual([]);
    });

    it('rebuilds a pre-baseline database that still holds the former Agent Commander tables', async () => {
        const { path } = await createDatabaseBeforeMigration('0013_caxri_bot_rename', (raw) => {
            raw.pragma(`user_version = ${BASELINE_SCHEMA_VERSION - 1}`);
        });

        const rebuilt = new CaxriDatabase(path);
        onTestFinished(() => rebuilt.close());
        expect(rebuilt.botTasks.list({ includeClosed: true })).toEqual([]);
    });
});
