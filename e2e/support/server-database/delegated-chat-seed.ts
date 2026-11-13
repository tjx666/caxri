import { join } from 'node:path';

import type { AgentDelegationReceipt, SessionRelation } from '@caxri/protocol';
import Database from 'better-sqlite3';

import { CaxriDatabase } from '../../../apps/server/src/domains/db';

interface Input {
    /**
     * `children` (app closed) creates the child Sessions and their settled records. `blocked` (app running) adds the
     * blocked record to `blockedSessionId`: the Server turns every task still active at startup into an interrupted
     * one, so a task that needs input can only be recorded after the Server has started. `deep` (app closed) creates
     * one direct child with a grandchild whose settled task failed, the case the parent strip rolls up "via" its
     * branch. `attention` (app closed) creates two settled children whose sidebar status raises unread attention: one
     * finished, one waiting on the user. The other phases leave every Session's attention at zero, so a nested row's
     * amber cue can only be inspected through this one.
     */
    phase: 'attention' | 'blocked' | 'children' | 'deep';
    blockedSessionId?: string;
    /**
     * The profile directory that holds `caxri.db`. The app must not be running on it.
     */
    userData: string;
    /**
     * The Session whose Chat delegated the seeded children, created through the app before it was closed.
     */
    hostSessionId: string;
    /**
     * The Project the host and the children live in.
     */
    projectId: string;
}

/**
 * The seeded children by the state the Delegated Sessions strip must word for them.
 */
export interface DelegatedChatSeed {
    /**
     * A failed task whose provider usage limit resets in 5 days 12 hours, relative to the seeding time.
     */
    quota: string;
    /**
     * A child whose task is blocked on a permission only the user can give, once the `blocked` phase recorded it.
     */
    needsInput: string;
    /**
     * A task that finished without an answer Caxri could read back.
     */
    answerUnavailable: string;
    /**
     * A consult child that has no delegation record.
     */
    consult: string;
}

/**
 * The `deep` phase's Sessions: a direct child of the host and the grandchild below it that failed.
 */
export interface DeepDelegatedChatSeed {
    branch: string;
    leaf: string;
}

/**
 * The `attention` phase's Sessions: a nested child with an unread finished result and one with an unread question.
 */
export interface AttentionDelegatedChatSeed {
    finished: string;
    waiting: string;
}

const HOUR = 3_600_000;

/**
 * Seeds the children of an existing host Session in the states the strip words specially. Only a Server-side Agent can
 * create a delegated Session, so a profile is seeded while the app is closed; the children have no Terminal, so nothing
 * starts an Agent.
 */
export function run(
    input: Input,
): AttentionDelegatedChatSeed | DeepDelegatedChatSeed | DelegatedChatSeed | null {
    const path = join(input.userData, 'caxri.db');
    const database = new CaxriDatabase(path);
    let attentionSeed: AttentionDelegatedChatSeed | undefined;
    try {
        const now = Date.now();
        // The blocked and deep phases can run on a database the children phase already filled (the debug skill's
        // `seed-delegated-chat.ts` runs children then deep), so each phase's IDs start in their own range.
        let sequence = { attention: 300, blocked: 100, children: 0, deep: 200 }[input.phase];
        const create = (
            title: string,
            relation: SessionRelation,
            createdBySessionId = input.hostSessionId,
        ) =>
            database.createSession(input.projectId, null, undefined, {
                selection: 'preserve',
                title,
                createdBySessionId,
                createdByRelation: relation,
            }).session.id;
        const record = (
            sessionId: string,
            receipt: {
                status: 'answer_unavailable' | 'blocked' | 'completed' | 'failed';
                failure?: AgentDelegationReceipt['failure'];
                failureResetsAt?: number;
                provider: 'claude' | 'codex';
                isSettled: boolean;
            },
        ) => {
            sequence += 1;
            const delegationId = `dispatch-${sequence.toString(16).padStart(64, '0')}`;
            const { isSettled, ...fields } = receipt;
            database.agentDelegations.insert({
                receipt: {
                    delegationId,
                    projectId: input.projectId,
                    sessionId,
                    ...fields,
                    ...(isSettled && { settledAt: now }),
                    revision: 1,
                    createdAt: now,
                    updatedAt: now,
                },
                principal: { kind: 'human-cli' as const, id: 'acceptance' },
                input: {
                    projectId: input.projectId,
                    sessionId,
                    provider: receipt.provider,
                    prompt: 'Synthetic delegated task',
                },
                fingerprint: 'e2e',
                promptDigest: '0'.repeat(64),
                frozenLaunch: { executable: receipt.provider, args: [] },
            });
        };
        if (input.phase === 'blocked') {
            record(input.blockedSessionId!, {
                status: 'blocked',
                failure: 'permission_required',
                provider: 'codex',
                isSettled: false,
            });
            return null;
        }
        if (input.phase === 'deep') {
            const branch = create('Coordinate the migration', 'delegated');
            const leaf = create('Port the billing exports', 'delegated', branch);
            record(branch, { status: 'completed', provider: 'codex', isSettled: true });
            record(leaf, {
                status: 'failed',
                failure: 'quota_exhausted',
                failureResetsAt: now + 5 * 24 * HOUR,
                provider: 'claude',
                isSettled: true,
            });
            return { branch, leaf };
        }
        if (input.phase === 'attention') {
            const finished = create('Draft the release notes', 'delegated');
            const waiting = create('Choose the rollout window', 'delegated');
            record(finished, { status: 'completed', provider: 'codex', isSettled: true });
            record(waiting, { status: 'completed', provider: 'claude', isSettled: true });
            attentionSeed = { finished, waiting };
            return attentionSeed;
        }
        const quota = create('Port the billing exports', 'delegated');
        record(quota, {
            status: 'failed',
            failure: 'quota_exhausted',
            failureResetsAt: now + 5 * 24 * HOUR + 12 * HOUR,
            provider: 'claude',
            isSettled: true,
        });
        const needsInput = create('Rotate the signing keys', 'delegated');
        const answerUnavailable = create('Summarize the audit log', 'delegated');
        record(answerUnavailable, {
            status: 'answer_unavailable',
            provider: 'codex',
            isSettled: true,
        });
        const consult = create('Quick second opinion', 'consult');
        return { quota, needsInput, answerUnavailable, consult };
    } finally {
        database.close();
        if (attentionSeed) raiseAttention(path, attentionSeed);
    }
}

/**
 * Marks the `attention` phase's children unread, the way a finished turn and a question would. The repository exposes
 * no write that raises attention without a Terminal's turn, so the rows are set directly, as `mobile-idle-cap-seed.ts`
 * does.
 */
function raiseAttention(path: string, { finished, waiting }: AttentionDelegatedChatSeed): void {
    const raw = new Database(path);
    try {
        const raise = raw.prepare(
            `UPDATE sessions SET attention_generation = 1, last_attention_kind = ?, agent_activity_state = ?
                WHERE id = ?`,
        );
        raw.transaction(() => {
            raise.run('completed', 'completed', finished);
            raise.run('waiting', 'waiting', waiting);
        })();
    } finally {
        raw.close();
    }
}
