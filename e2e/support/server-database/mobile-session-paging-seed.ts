import { join } from 'node:path';

import Database from 'better-sqlite3';

import { CaxriDatabase } from '../../../apps/server/src/domains/db';

interface Input {
    /**
     * The profile directory that holds `caxri.db`.
     */
    userData: string;
    /**
     * A parent folder for the three seeded Project roots, which must already exist.
     */
    roots: { backlog: string; dormant: string; recent: string };
}

export interface MobileSessionPagingSeed {
    /**
     * The Project with a long Needs attention backlog and one new Idle Session.
     */
    backlogProjectId: string;
    /**
     * Finished Sessions in Needs attention, newest first.
     */
    attention: string[];
    /**
     * The Project's newest Session, Idle: it must stay reachable behind the backlog.
     */
    newIdle: string;
    /**
     * A Project with work two days ago, so its chip stays in the strip.
     */
    recentProjectId: string;
    /**
     * A Project untouched for a month, so its chip waits behind More.
     */
    dormantProjectId: string;
    dormantSessionId: string;
}

/**
 * More finished Sessions than the phone dashboard's former 64-Session cap, so a backlog that once crowded every Idle
 * Session off the phone is in place (issue #4072).
 */
const ATTENTION_COUNT = 70;

const DAY_MS = 24 * 60 * 60_000;

/**
 * Seeds three Projects: one with 70 finished Sessions in Needs attention and a newer Idle Session, one with a Session
 * active two days ago, and one whose only Session was last active and opened a month ago. Only a Server-side Agent turn
 * raises attention, so the profile is seeded before the first launch; the Sessions have no Terminal, so nothing starts
 * an Agent.
 */
export function run(input: Input): MobileSessionPagingSeed {
    const path = join(input.userData, 'caxri.db');
    const database = new CaxriDatabase(path);
    const now = Date.now();
    let seed: MobileSessionPagingSeed;
    const attentionAt: Array<{ id: string; at: number }> = [];
    const aged: Array<{ id: string; at: number }> = [];
    try {
        const backlog = database.createProject(input.roots.backlog);
        const recent = database.createProject(input.roots.recent);
        const dormant = database.createProject(input.roots.dormant);
        const create = (projectId: string, title: string) =>
            database.createSession(projectId, null, undefined, { selection: 'preserve', title })
                .session.id;
        const attention: string[] = [];
        for (let index = 0; index < ATTENTION_COUNT; index += 1) {
            const id = create(backlog.id, `Finished task ${index + 1}`);
            attention.push(id);
            attentionAt.push({ id, at: now - 60_000 - index * 1_000 });
        }
        const newIdle = create(backlog.id, 'Plan the next release');
        aged.push({ id: create(recent.id, 'Review the docs draft'), at: now - 2 * DAY_MS });
        const dormantSessionId = create(dormant.id, 'Old experiment');
        aged.push({ id: dormantSessionId, at: now - 30 * DAY_MS });
        seed = {
            backlogProjectId: backlog.id,
            attention,
            newIdle,
            recentProjectId: recent.id,
            dormantProjectId: dormant.id,
            dormantSessionId,
        };
    } finally {
        database.close();
    }
    // The repository exposes no write that raises attention or ages a Session without real time passing, so set the
    // rows directly.
    const raw = new Database(path);
    try {
        const raise = raw.prepare(
            `UPDATE sessions SET attention_generation = 1, last_attention_kind = 'completed',
                agent_activity_state = 'completed', session_activity_at = ? WHERE id = ?`,
        );
        const age = raw.prepare(
            'UPDATE sessions SET session_activity_at = ?, last_visited_at = ? WHERE id = ?',
        );
        raw.transaction(() => {
            for (const { id, at } of attentionAt) raise.run(at, id);
            for (const { id, at } of aged) age.run(at, at, id);
        })();
    } finally {
        raw.close();
    }
    return seed;
}
