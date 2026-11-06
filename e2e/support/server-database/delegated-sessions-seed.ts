import { join } from 'node:path';

import type { SessionRelation } from '@caxri/protocol';

import { CaxriDatabase } from '../../../apps/server/src/domains/db';

interface Input {
    /**
     * The profile directory that holds `caxri.db`.
     */
    userData: string;
    /**
     * The Project roots to register, in sidebar order: the host's Project first, then the Project the delegated
     * Sessions live in.
     */
    roots: [string, string];
    /**
     * How many settled Sessions the fan-out host delegated to, more than the child window shows by default.
     */
    fanOut: number;
}

export interface DelegatedSessionsSeed {
    hostProjectId: string;
    workerProjectId: string;
    /**
     * The Session that delegated to `reviewer` and `failed`, started a hand-off and a consult.
     */
    host: string;
    /**
     * Delegated into the worker Project; no delegation record survives for it, as after pruning.
     */
    reviewer: string;
    /**
     * Delegated into the worker Project; its delegation failed.
     */
    failed: string;
    /**
     * Delegated into the worker Project; the user took over its delegation, which is not a failure.
     */
    takenOver: string;
    consult: string;
    handoff: string;
    /**
     * A second host with `fanOut` settled delegated Sessions in the worker Project, oldest first.
     */
    fanOutHost: string;
    fanOutChildren: string[];
}

/**
 * One delegation record the way a real launch leaves it: only the fields the Delegated Session feed reads matter
 * (`sessionId`, `status`, `failure`, `settledAt`), so the launch, principal, and prompt are placeholders.
 */
type DelegationStatus = 'completed' | 'failed' | 'human_intervened';

function delegationRecord(input: {
    delegationId: string;
    projectId: string;
    sessionId: string;
    status: DelegationStatus;
    failure?: 'provider_failed';
    now: number;
}) {
    const { delegationId, projectId, sessionId, status, failure, now } = input;
    return {
        receipt: {
            delegationId,
            projectId,
            sessionId,
            provider: 'codex' as const,
            status,
            ...(failure && { failure }),
            settledAt: now,
            revision: 1,
            createdAt: now,
            updatedAt: now,
        },
        principal: { kind: 'human-cli' as const, id: 'acceptance' },
        input: {
            projectId,
            sessionId,
            provider: 'codex' as const,
            prompt: 'Synthetic delegated task',
        },
        fingerprint: 'e2e',
        promptDigest: '0'.repeat(64),
        frozenLaunch: { executable: 'codex', args: [] },
        // A task the user took over carries the takeover mark the feed derives `control: 'human'` from.
        ...(status === 'human_intervened' && {
            hasHumanIntervention: true,
            humanInterventionAt: now,
        }),
    };
}

/**
 * Seeds two Projects with the Session shapes the sidebar nests: a host with delegated, consulted and handed-off
 * Sessions in the other Project (one failed, one taken over by the user, one with no record), and a second host whose
 * many settled children overflow the child window. Delegated Sessions can only be created by a Server-side Agent, so
 * the profile is seeded before the app first launches; the Sessions have no Terminal, so nothing starts an Agent.
 */
export function run(input: Input): DelegatedSessionsSeed {
    const database = new CaxriDatabase(join(input.userData, 'caxri.db'));
    try {
        const hostProject = database.createProject(input.roots[0]);
        const workerProject = database.createProject(input.roots[1]);
        const create = (
            projectId: string,
            title: string,
            creator?: { sessionId: string; relation: SessionRelation },
        ) =>
            database.createSession(projectId, null, undefined, {
                selection: 'preserve',
                title,
                ...(creator && {
                    createdBySessionId: creator.sessionId,
                    createdByRelation: creator.relation,
                }),
            }).session.id;
        const now = Date.now();
        let sequence = 0;
        const record = (
            sessionId: string,
            projectId: string,
            status: DelegationStatus,
            failure?: 'provider_failed',
        ) => {
            sequence += 1;
            database.agentDelegations.insert(
                delegationRecord({
                    delegationId: `dispatch-${sequence.toString(16).padStart(64, '0')}`,
                    projectId,
                    sessionId,
                    status,
                    failure,
                    now,
                }),
            );
        };

        const host = create(hostProject.id, 'Coordinator');
        const delegated = (title: string) =>
            create(workerProject.id, title, { sessionId: host, relation: 'delegated' });
        const reviewer = delegated('Review the retry design');
        const failed = delegated('Migrate the fixtures');
        const takenOver = delegated('Audit the changelog');
        const consult = create(workerProject.id, 'Quick second opinion', {
            sessionId: host,
            relation: 'consult',
        });
        const handoff = create(workerProject.id, 'Continue in the worker', {
            sessionId: host,
            relation: 'handoff',
        });
        record(failed, workerProject.id, 'failed', 'provider_failed');
        record(takenOver, workerProject.id, 'human_intervened');

        const fanOutHost = create(hostProject.id, 'Fan-out host');
        const fanOutChildren = Array.from({ length: input.fanOut }, (_, index) => {
            const child = create(workerProject.id, `Fan-out task ${index + 1}`, {
                sessionId: fanOutHost,
                relation: 'delegated',
            });
            record(child, workerProject.id, 'completed');
            return child;
        });

        return {
            hostProjectId: hostProject.id,
            workerProjectId: workerProject.id,
            host,
            reviewer,
            failed,
            takenOver,
            consult,
            handoff,
            fanOutHost,
            fanOutChildren,
        };
    } finally {
        database.close();
    }
}
