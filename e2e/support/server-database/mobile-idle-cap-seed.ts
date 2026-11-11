import { join } from 'node:path';

import Database from 'better-sqlite3';

import { CaxriDatabase } from '../../../apps/server/src/domains/db';

interface Input {
    /**
     * The profile directory that holds `caxri.db`.
     */
    userData: string;
    /**
     * The root of the one Project the seeded Sessions live in.
     */
    root: string;
}

export interface MobileIdleCapSeed {
    projectId: string;
    /**
     * The one Session in Needs attention the home list shows: it ranks first in every build, so it marks the list as
     * loaded.
     */
    waiting: string;
    /**
     * Idle Sessions the cap used to drop, newest first.
     */
    idle: string[];
    /**
     * The archived Session that started every second opinion.
     */
    archivedHost: string;
    /**
     * The archived Session's unresolved second opinions, which the home list hides.
     */
    hiddenConsults: string[];
}

/**
 * More unresolved second opinions than the phone dashboard's 64-Session cap: each one's creator is archived, so the
 * home list hides it, yet ranked by status alone they used to fill the cap ahead of the Project's Idle Sessions (issue
 * #3946).
 */
const HIDDEN_CONSULT_COUNT = 70;

/**
 * Seeds one Project with an archived Session's 70 unresolved second opinions, one Session waiting on the user, and
 * three Idle Sessions. Only a Server-side Agent creates consult Sessions and raises attention, so the profile is seeded
 * before the first launch; the Sessions have no Terminal, so nothing starts an Agent.
 */
export function run(input: Input): MobileIdleCapSeed {
    const path = join(input.userData, 'caxri.db');
    const database = new CaxriDatabase(path);
    let seed: MobileIdleCapSeed;
    const attention: Array<{ id: string; kind: 'completed' | 'waiting'; at: number }> = [];
    const recency: Array<{ id: string; at: number }> = [];
    const now = Date.now();
    try {
        const project = database.createProject(input.root);
        const create = (title: string, creator?: string) =>
            database.createSession(project.id, null, undefined, {
                selection: 'preserve',
                title,
                ...(creator && { createdBySessionId: creator, createdByRelation: 'consult' }),
            }).session.id;
        const archivedHost = create('Finished investigation');
        const hiddenConsults: string[] = [];
        for (let index = 0; index < HIDDEN_CONSULT_COUNT; index += 1) {
            const id = create(`Second opinion ${index + 1}`, archivedHost);
            hiddenConsults.push(id);
            attention.push({ id, kind: 'completed', at: now - 60_000 - index * 1_000 });
        }
        database.archiveSession(archivedHost);
        const waiting = create('Confirm the release checklist');
        attention.push({ id: waiting, kind: 'waiting', at: now });
        const idle = [
            'Draft the onboarding copy',
            'Tidy the settings page',
            'Check the export flow',
        ].map((title, index) => {
            const id = create(title);
            recency.push({ id, at: now - 3_600_000 - index * 60_000 });
            return id;
        });
        seed = { projectId: project.id, waiting, idle, archivedHost, hiddenConsults };
    } finally {
        database.close();
    }
    // The repository exposes no write that raises attention without a Terminal's turn, so set the rows directly.
    const raw = new Database(path);
    try {
        const raise = raw.prepare(
            `UPDATE sessions SET attention_generation = 1, last_attention_kind = ?, agent_activity_state = ?,
                session_activity_at = ? WHERE id = ?`,
        );
        const age = raw.prepare('UPDATE sessions SET session_activity_at = ? WHERE id = ?');
        raw.transaction(() => {
            for (const { id, kind, at } of attention) raise.run(kind, kind, at, id);
            for (const { id, at } of recency) age.run(at, id);
        })();
    } finally {
        raw.close();
    }
    return seed;
}
