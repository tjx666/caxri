import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SessionRelation } from '@caxri/protocol';
import { describe, expect, it, onTestFinished } from 'vitest';

import { CaxriDatabase } from '../../db';
import {
    delegatedCost,
    delegatedDescendants,
    MAX_ROLLUP_DEPTH,
    MAX_ROLLUP_DESCENDANTS,
    sessionCostWithDelegated,
} from '../delegated-cost';
import type { ModelPrice } from '../pricing';
import type { UsageRecord } from '../record';

const HOUR = 1_700_000_000 - (1_700_000_000 % 3600);
const PRICE: ModelPrice = [1e-6, 2e-6, 1e-7, 1.25e-6, 2e-6];
const priceOf = (model: string) => (model === 'priced' ? PRICE : undefined);

/**
 * `priced` costs 100 * 1e-6 = $0.0001 a record; `unpriced` adds no cost and marks the sum partial.
 */
function usageJson(model: 'priced' | 'unpriced'): string {
    const record: UsageRecord = {
        version: 3,
        models: [model],
        tokens: [[HOUR, 0, 100, 0, 0, 0, 0, 0, 0]],
        activity: [],
        pullRequests: [],
    };
    return JSON.stringify(record);
}

async function setup() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-delegated-cost-'));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    onTestFinished(async () => {
        database.close();
        await rm(directory, { recursive: true, force: true });
    });
    const project = database.createProject(join(directory, 'project'));
    let count = 0;
    const create = (parent?: string, relation: SessionRelation = 'delegated') =>
        database.createSession(project.id, null, undefined, {
            ...(parent && { createdBySessionId: parent, createdByRelation: relation }),
        }).session.id;
    const spend = (sessionId: string, model: 'priced' | 'unpriced' = 'priced', extra = '') => {
        count += 1;
        database.database
            .prepare(
                `INSERT INTO agent_session_usage (provider, agent_session_id, session_id, project_id, terminal_id, cwd, bound_at, usage_json)
                 VALUES ('claude', ?, ?, ?, ?, '/tmp', 1, ?)`,
            )
            .run(
                `agent-${count}${extra}`,
                sessionId,
                project.id,
                `terminal-${count}`,
                usageJson(model),
            );
    };
    return { database, create, spend, project };
}

describe('delegatedCost', () => {
    it('adds up transitive descendants once each and groups them by direct child', async () => {
        const { database, create, spend } = await setup();
        const root = create();
        const childA = create(root);
        const childB = create(root);
        const grandchild = create(childA);
        for (const id of [childA, childB, grandchild]) spend(id);
        spend(root);

        const cost = delegatedCost(database, root, priceOf);

        expect(cost.delegatedSessions).toBe(3);
        expect(cost.delegatedCostUsd).toBeCloseTo(3e-4);
        expect(cost.isPartial).toBe(false);
        expect(
            Object.fromEntries(cost.children.map((child) => [child.sessionId, child.sessionCount])),
        ).toEqual({ [childA]: 2, [childB]: 1 });
    });

    it('counts a Session reached by two paths once (diamond) and ends on a cycle', async () => {
        const { database, create, spend } = await setup();
        const root = create();
        const left = create(root);
        const right = create(root);
        const shared = create(left);
        database.agentDelegations.history.recordEdge({
            sessionId: shared,
            parentSessionId: right,
            relation: 'delegated',
            createdAt: 1,
        });
        // A cycle back to the root.
        database.agentDelegations.history.recordEdge({
            sessionId: root,
            parentSessionId: shared,
            relation: 'delegated',
            createdAt: 1,
        });
        spend(shared);

        const cost = delegatedCost(database, root, priceOf);

        expect(cost.delegatedSessions).toBe(1);
        expect(cost.delegatedCostUsd).toBeCloseTo(1e-4);
        const byName = (a: string, b: string) => a.localeCompare(b);
        expect(
            delegatedDescendants(database, root).branchOf.keys().toArray().toSorted(byName),
        ).toEqual([left, right, shared].toSorted(byName));
    });

    it('walks exactly the descendant bound without marking it partial, and marks one more partial', async () => {
        const { database, create } = await setup();
        const root = create();
        const sessions = Array.from({ length: MAX_ROLLUP_DESCENDANTS + 1 }, () => create(root));

        // Exactly 1000 descendants: the root does not count against the bound.
        database.deleteSession(sessions.pop()!);
        // The edge outlives its deleted Session, so drop it to leave exactly 1000.
        database.database
            .prepare(
                'DELETE FROM delegation_edges WHERE session_id NOT IN (SELECT id FROM sessions) AND session_id <> ?',
            )
            .run(root);
        const exact = delegatedDescendants(database, root);
        expect(exact.branchOf.size).toBe(MAX_ROLLUP_DESCENDANTS);
        expect(exact.isTruncated).toBe(false);

        create(root);
        const over = delegatedDescendants(database, root);
        expect(over.branchOf.size).toBe(MAX_ROLLUP_DESCENDANTS);
        expect(over.isTruncated).toBe(true);
        expect(delegatedCost(database, root, priceOf).isPartial).toBe(true);
    });

    it('marks a chain deeper than the depth bound partial and reads the levels it can', async () => {
        const { database, create } = await setup();
        const root = create();
        let tip = root;
        const chain: string[] = [];
        for (let depth = 0; depth < MAX_ROLLUP_DEPTH + 2; depth += 1) {
            tip = create(tip);
            chain.push(tip);
        }

        const { branchOf, isTruncated } = delegatedDescendants(database, root);

        expect(isTruncated).toBe(true);
        expect(branchOf.keys().toArray()).toEqual(chain.slice(0, MAX_ROLLUP_DEPTH));
        // Exactly the depth bound below a Session is fully read.
        expect(delegatedDescendants(database, chain[0]).isTruncated).toBe(true);
        expect(delegatedDescendants(database, chain[1]).isTruncated).toBe(false);
    });

    it('rolls up delegated and consult Sessions but not a hand-off', async () => {
        const { database, create, spend } = await setup();
        const root = create();
        for (const relation of ['delegated', 'consult', 'handoff'] as const)
            spend(create(root, relation));

        const cost = delegatedCost(database, root, priceOf);

        expect(cost.delegatedSessions).toBe(2);
    });

    it('keeps the cost of a deleted child, a deleted middle Session, and a deleted creator', async () => {
        const { database, create, spend } = await setup();
        const root = create();
        const middle = create(root);
        const leaf = create(middle);
        const unsettledChild = create(root);
        spend(middle);
        spend(leaf);
        spend(unsettledChild);

        database.deleteSession(middle);
        database.deleteSession(unsettledChild);

        const cost = delegatedCost(database, root, priceOf);
        expect(cost.delegatedSessions).toBe(3);
        // The child's own cost is unchanged by the creator's deletion.
        database.deleteSession(root);
        expect(sessionCostWithDelegated(database, leaf, priceOf)?.costUsd).toBeCloseTo(1e-4);
    });

    it('flags an unpriced model as partial across the tree while keeping the priced part', async () => {
        const { database, create, spend } = await setup();
        const root = create();
        const child = create(root);
        const unpriced = create(child);
        spend(child);
        spend(unpriced, 'unpriced');

        const cost = delegatedCost(database, root, priceOf);

        expect(cost.isPartial).toBe(true);
        expect(cost.delegatedCostUsd).toBeCloseTo(1e-4);
        expect(cost.children.at(0)).toMatchObject({ isPartial: true, sessionCount: 2 });
    });

    it('stays active while a transitive descendant task is running', async () => {
        const { database, create, spend } = await setup();
        const root = create();
        const child = create(root);
        const grandchild = create(child);
        spend(child);
        // Only the grandchild has a running task; the child's own subtree is still active.
        database.agentDelegations.receiptsForSessions = (ids) =>
            ids.includes(grandchild) ? [{ status: 'running', sessionId: grandchild } as never] : [];

        expect(delegatedCost(database, root, priceOf).isActive).toBe(true);
    });

    it('is empty with no descendants', async () => {
        const { database, create } = await setup();
        const root = create();

        expect(delegatedCost(database, root, priceOf)).toEqual({
            delegatedCostUsd: 0,
            delegatedSessions: 0,
            isPartial: false,
            isActive: false,
            children: [],
        });
        expect(sessionCostWithDelegated(database, root, priceOf)).toBeNull();
    });
});

describe('sessionCostWithDelegated', () => {
    it('keeps own usage unknown instead of returning $0 when only descendants have usage', async () => {
        const { database, create, spend } = await setup();
        const root = create();
        spend(create(root));

        const cost = sessionCostWithDelegated(database, root, priceOf);

        expect(cost).not.toHaveProperty('costUsd');
        expect(cost).not.toHaveProperty('isPartial');
        expect(cost).toMatchObject({ delegatedSessions: 1, delegatedIsPartial: false });
    });

    it('reports own and delegated spend separately', async () => {
        const { database, create, spend } = await setup();
        const root = create();
        spend(root);
        spend(create(root));

        const cost = sessionCostWithDelegated(database, root, priceOf);

        expect(cost?.costUsd).toBeCloseTo(1e-4);
        expect(cost?.delegatedCostUsd).toBeCloseTo(1e-4);
    });

    it('omits the delegated fields without descendant usage', async () => {
        const { database, create, spend } = await setup();
        const root = create();
        spend(root);

        const cost = sessionCostWithDelegated(database, root, priceOf);

        expect(cost).toEqual({ costUsd: expect.any(Number) as number, isPartial: false });
    });
});
