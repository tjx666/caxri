import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SessionRelation } from '@caxri/protocol';
import { describe, expect, it, onTestFinished } from 'vitest';

import {
    delegatedDescendants,
    MAX_ROLLUP_DEPTH,
    MAX_ROLLUP_DESCENDANTS,
} from '../../agent-delegation/tree';
import { CaxriDatabase } from '../../db';
import { delegatedCost, sessionCostWithDelegated } from '../delegated-cost';
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
        spend(shared);
        /**
         * `session_id` is the edge table's primary key, so a real database holds one creator per Session. Stand in a
         * reader that returns the diamond (root -> left, right -> shared twice) and a cycle (shared -> root).
         */
        const edge = (sessionId: string, parentSessionId: string) => ({
            sessionId,
            parentSessionId,
            relation: 'delegated' as const,
        });
        const edges = [
            edge(left, root),
            edge(right, root),
            edge(shared, left),
            edge(shared, right),
            edge(root, shared),
        ];
        const diamond = {
            agentDelegations: {
                receiptsForSessions: () => [],
                history: {
                    childEdges: (parents: readonly string[]) =>
                        edges.filter((candidate) => parents.includes(candidate.parentSessionId)),
                },
            },
            agentSessionUsage: database.agentSessionUsage,
        } as unknown as CaxriDatabase;
        // Both paths to `shared` really exist before the walk dedupes them.
        const sharedParents = edges
            .filter((candidate) => candidate.sessionId === shared)
            .map((candidate) => candidate.parentSessionId);
        expect(sharedParents).toEqual([left, right]);

        const cost = delegatedCost(diamond, root, priceOf);

        expect(cost.delegatedSessions).toBe(1);
        expect(cost.delegatedCostUsd).toBeCloseTo(1e-4);
        const byName = (a: string, b: string) => a.localeCompare(b);
        expect(
            delegatedDescendants(diamond, root).branchOf.keys().toArray().toSorted(byName),
        ).toEqual([left, right, shared].toSorted(byName));
    });

    it('reads no more edges than the remaining budget plus one, however wide a level is', async () => {
        const { database, create } = await setup();
        const root = create();
        for (let index = 0; index < MAX_ROLLUP_DESCENDANTS + 50; index += 1) create(root);
        const history = database.agentDelegations.history;
        const read: number[] = [];
        const original = history.childEdges.bind(history);
        history.childEdges = (parents, relations, limit) => {
            const edges = original(parents, relations, limit);
            read.push(edges.length);
            return edges;
        };

        const { branchOf, isTruncated } = delegatedDescendants(database, root);

        expect(read).toEqual([MAX_ROLLUP_DESCENDANTS + 1]);
        expect(branchOf.size).toBe(MAX_ROLLUP_DESCENDANTS);
        expect(isTruncated).toBe(true);
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

    it('marks the direct child whose subtree was cut short as partial, not only the root', async () => {
        const { database, create, spend } = await setup();
        const root = create();
        const deep = create(root);
        const shallow = create(root);
        spend(deep);
        spend(shallow);
        let tip = deep;
        for (let depth = 0; depth < MAX_ROLLUP_DEPTH; depth += 1) tip = create(tip);

        const cost = delegatedCost(database, root, priceOf);

        expect(cost.isPartial).toBe(true);
        const byId = Object.fromEntries(cost.children.map((child) => [child.sessionId, child]));
        expect(byId[deep]?.isPartial).toBe(true);
        expect(byId[shallow]?.isPartial).toBe(false);
    });

    it('keeps a branch that only has a running task so its row can show ~', async () => {
        const { database, create, spend } = await setup();
        const root = create();
        const oldAttempt = create(root);
        const freshRetry = create(root);
        spend(oldAttempt);
        database.agentDelegations.receiptsForSessions = (ids) =>
            ids.includes(freshRetry) ? [{ status: 'running', sessionId: freshRetry } as never] : [];

        const cost = delegatedCost(database, root, priceOf);

        expect(cost.delegatedSessions).toBe(1);
        expect(cost.isActive).toBe(true);
        expect(cost.children.find((child) => child.sessionId === freshRetry)).toMatchObject({
            isActive: true,
            sessionCount: 0,
            costUsd: 0,
        });
    });

    it('rolls up delegated and consult Sessions but not a hand-off or an independent Session', async () => {
        const { database, create, spend } = await setup();
        const root = create();
        for (const relation of ['delegated', 'consult', 'handoff', 'independent'] as const)
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
