import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import type { AgentProvider, ProcessState, TerminalKind, TerminalRecord } from '../../shared/types';

export const MAX_TERMINALS_PER_SESSION = 16;
export const MAX_TERMINALS_GLOBAL = 32;

interface TerminalRow {
    id: string;
    session_id: string;
    kind: TerminalKind;
    provider: 'claude' | 'codex' | null;
    cwd: string;
    title: string;
    icon: string;
    order_index: number;
    layout_node_id: string;
    agent_session_id: string | null;
    last_process_state: ProcessState;
    created_at: number;
    updated_at: number;
}

function mapTerminal(row: TerminalRow): TerminalRecord {
    return {
        id: row.id,
        sessionId: row.session_id,
        kind: row.kind,
        provider: row.provider ?? undefined,
        cwd: row.cwd,
        title: row.title,
        icon: row.icon,
        orderIndex: row.order_index,
        layoutNodeId: row.layout_node_id,
        agentSessionId: row.agent_session_id ?? undefined,
        lastProcessState: row.last_process_state,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export interface NewTerminalInput {
    sessionId: string;
    kind: TerminalKind;
    cwd: string;
    title: string;
}

/**
 * Pure CRUD over the `terminals` table. `order_index` is assigned atomically from the current
 * per-Session maximum (`COALESCE(MAX(order_index) + 1, 0)`), so a Terminal removed from the middle
 * of a Session never collides with a surviving one's index. Every caller shares this one INSERT
 * instead of duplicating it.
 */
export class TerminalsStore {
    constructor(private readonly database: Database.Database) {}

    /** Stable order: `order_index` first, `id` breaks ties for any legacy equal-index rows. */
    list(sessionId?: string): TerminalRecord[] {
        const rows = sessionId
            ? (this.database
                  .prepare(
                      'SELECT * FROM terminals WHERE session_id = ? ORDER BY order_index ASC, id ASC',
                  )
                  .all(sessionId) as TerminalRow[])
            : (this.database
                  .prepare(
                      'SELECT * FROM terminals ORDER BY session_id ASC, order_index ASC, id ASC',
                  )
                  .all() as TerminalRow[]);
        return rows.map(mapTerminal);
    }

    get(id: string): TerminalRecord | undefined {
        const row = this.database.prepare('SELECT * FROM terminals WHERE id = ?').get(id) as
            TerminalRow | undefined;
        return row ? mapTerminal(row) : undefined;
    }

    countAll(): number {
        return (
            this.database.prepare('SELECT COUNT(*) AS count FROM terminals').get() as {
                count: number;
            }
        ).count;
    }

    countForSession(sessionId: string): number {
        return (
            this.database
                .prepare('SELECT COUNT(*) AS count FROM terminals WHERE session_id = ?')
                .get(sessionId) as { count: number }
        ).count;
    }

    insert(input: NewTerminalInput): TerminalRecord {
        const id = randomUUID();
        const now = Date.now();
        this.database
            .prepare(
                `INSERT INTO terminals
                 (id, session_id, kind, provider, cwd, title, icon, order_index, layout_node_id,
                  last_process_state, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?,
                         COALESCE((SELECT MAX(order_index) + 1 FROM terminals WHERE session_id = ?), 0),
                         ?, 'starting', ?, ?)`,
            )
            .run(
                id,
                input.sessionId,
                input.kind,
                input.kind === 'shell' ? null : input.kind,
                input.cwd,
                input.title,
                input.kind,
                input.sessionId,
                randomUUID(),
                now,
                now,
            );
        return this.get(id)!;
    }

    remove(id: string): boolean {
        return this.database.prepare('DELETE FROM terminals WHERE id = ?').run(id).changes === 1;
    }

    updateState(id: string, state: ProcessState, now = Date.now()): void {
        this.database
            .prepare('UPDATE terminals SET last_process_state = ?, updated_at = ? WHERE id = ?')
            .run(state, now, id);
    }

    updateAgentSessionId(id: string, agentSessionId: string | undefined, now = Date.now()): void {
        this.database
            .prepare('UPDATE terminals SET agent_session_id = ?, updated_at = ? WHERE id = ?')
            .run(agentSessionId ?? null, now, id);
    }

    promoteShellToAgent(
        id: string,
        provider: AgentProvider,
        title: string,
        now = Date.now(),
    ): boolean {
        return (
            this.database
                .prepare(
                    `UPDATE terminals
                     SET kind = ?, provider = ?, title = ?, icon = ?, updated_at = ?
                     WHERE id = ? AND kind = 'shell' AND provider IS NULL`,
                )
                .run(provider, provider, title, provider, now, id).changes === 1
        );
    }
}
