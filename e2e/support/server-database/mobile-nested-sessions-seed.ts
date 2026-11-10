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
    /**
     * An archived Session, the creator of `retiredConsult`.
     */
    archivedHost: string;
    /**
     * A second opinion whose creator is archived: the home list retires it like Desktop's Projects tree.
     */
    retiredConsult: string;
}

/**
 * Seeds one Project with a host Session and the three Sessions it started: a second opinion (`consult`), a delegated
 * task, and a hand-off, plus an archived Session's second opinion. Only a Server-side Agent creates consult and
 * delegated Sessions, so the profile is seeded before the first launch; the Sessions have no Terminal, so nothing
 * starts an Agent.
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
        const archivedHost = create('Finished investigation');
        const retiredConsult = create('Earlier second opinion', {
            host: archivedHost,
            relation: 'consult',
        });
        database.archiveSession(archivedHost);
        return {
            projectId: project.id,
            host,
            archivedHost,
            consult: started('Quick second opinion', 'consult'),
            delegated: started('Review the retry design', 'delegated'),
            handoff: started('Continue in the worker', 'handoff'),
            retiredConsult,
        };
    } finally {
        database.close();
    }
}
