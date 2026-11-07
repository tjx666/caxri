import { join } from 'node:path';

import type { SessionRelation } from '@caxri/protocol';

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

export interface MobileNestedSessionsSeed {
    projectId: string;
    /**
     * The Session that consulted, delegated to, and handed off to the others.
     */
    host: string;
    consult: string;
    delegated: string;
    handoff: string;
}

/**
 * Seeds one Project with a host Session and the three Sessions it started: a second opinion (`consult`), a delegated
 * task, and a hand-off. Only a Server-side Agent creates the first two, so the profile is seeded before the first
 * launch; the Sessions have no Terminal, so nothing starts an Agent.
 */
export function run(input: Input): MobileNestedSessionsSeed {
    const database = new CaxriDatabase(join(input.userData, 'caxri.db'));
    try {
        const project = database.createProject(input.root);
        const create = (title: string, creator?: { host: string; relation: SessionRelation }) =>
            database.createSession(project.id, null, undefined, {
                selection: 'preserve',
                title,
                ...(creator && {
                    createdBySessionId: creator.host,
                    createdByRelation: creator.relation,
                }),
            }).session.id;
        const host = create('Coordinator');
        const started = (title: string, relation: SessionRelation) =>
            create(title, { host, relation });
        return {
            projectId: project.id,
            host,
            consult: started('Quick second opinion', 'consult'),
            delegated: started('Review the retry design', 'delegated'),
            handoff: started('Continue in the worker', 'handoff'),
        };
    } finally {
        database.close();
    }
}
