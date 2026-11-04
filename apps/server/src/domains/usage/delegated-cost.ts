import type { DelegationCostSummary, SessionCost, SessionRelation } from '@caxri/protocol';
import { isDelegationActive } from '@caxri/protocol';

import type { CaxriDatabase } from '../db';
import { parseUsageRecord } from './record';
import type { ModelPriceLookup } from './summary';
import { sessionCostOf } from './summary';

/**
 * Most descendant Sessions one roll-up reads, not counting the root. Equal to the Delegated Sessions feed bound.
 */
export const MAX_ROLLUP_DESCENDANTS = 1000;

/**
 * Deepest chain of delegations one roll-up follows below its root.
 */
export const MAX_ROLLUP_DEPTH = 8;

/**
 * Relations whose Sessions bill as delegated work: a delegated task and a consult (an Agent asked another to look into
 * something). A hand-off moves the user's own continuation to another Session, so it is not delegated spend.
 */
const ROLLED_UP_RELATIONS: readonly SessionRelation[] = ['delegated', 'consult'];

type DelegatedCost = Omit<DelegationCostSummary, 'isScanPending'>;

/**
 * The descendants of `rootSessionId` by creator edges, breadth first. Each level reads at most the remaining descendant
 * budget plus one edge (a SQL `LIMIT`, in chunks of 500 parents through the `delegation_edges.parent_session_id`
 * index), so a huge fan-out is never loaded whole. A Session is visited once however many paths reach it (a diamond or
 * a cycle), the root does not count against {@link MAX_ROLLUP_DESCENDANTS}, and reaching either the descendant bound or
 * {@link MAX_ROLLUP_DEPTH} marks the walk `isTruncated` and stops expanding.
 *
 * `branchOf` maps each descendant to the direct child of the root its subtree belongs to (the first one that reached
 * it). `truncatedBranches` are the direct children whose subtree may hold Sessions that were not read: a level that was
 * cut short marks every branch it was expanding, since the unread edges cannot be attributed.
 */
export function delegatedDescendants(
    database: Pick<CaxriDatabase, 'agentDelegations'>,
    rootSessionId: string,
): { branchOf: Map<string, string>; isTruncated: boolean; truncatedBranches: Set<string> } {
    const { history } = database.agentDelegations;
    const branchOf = new Map<string, string>();
    const truncatedBranches = new Set<string>();
    let isTruncated = false;
    let frontier = [rootSessionId];
    for (let depth = 0; frontier.length > 0; depth += 1) {
        const remaining = depth >= MAX_ROLLUP_DEPTH ? 0 : MAX_ROLLUP_DESCENDANTS - branchOf.size;
        const edges = history
            .childEdges(frontier, ROLLED_UP_RELATIONS, remaining + 1)
            .filter((edge) => edge.sessionId !== rootSessionId && !branchOf.has(edge.sessionId))
            .filter(
                (edge, index, all) =>
                    all.findIndex((other) => other.sessionId === edge.sessionId) === index,
            );
        const next: string[] = [];
        for (const { sessionId, parentSessionId } of edges.slice(0, remaining)) {
            branchOf.set(
                sessionId,
                parentSessionId === rootSessionId ? sessionId : branchOf.get(parentSessionId)!,
            );
            next.push(sessionId);
        }
        if (edges.length > remaining) {
            isTruncated = true;
            for (const id of [...frontier, ...next])
                if (id !== rootSessionId) truncatedBranches.add(branchOf.get(id)!);
            break;
        }
        frontier = next;
    }
    return { branchOf, isTruncated, truncatedBranches };
}

/**
 * What the Sessions below `rootSessionId` have cost, grouped by the root's direct children. Prices every Session's
 * ledger rows through the same `sessionCostOf` the Usage report uses, so there is one accounting path; a Session whose
 * ledger rows hold no usage yet (a scan has not read them) adds nothing. A deleted Session keeps its ledger rows and so
 * its cost. `isActive` is true while any task in a subtree is still running, because its figure may still grow.
 */
export function delegatedCost(
    database: Pick<CaxriDatabase, 'agentDelegations' | 'agentSessionUsage'>,
    rootSessionId: string,
    priceOf: ModelPriceLookup,
): DelegatedCost {
    const { branchOf, isTruncated, truncatedBranches } = delegatedDescendants(
        database,
        rootSessionId,
    );
    const sessionIds = branchOf.keys().toArray();
    const rowsBySession = new Map<string, Array<ReturnType<typeof parseUsageRecord>>>();
    for (const row of database.agentSessionUsage.listForSessions(sessionIds)) {
        const records = rowsBySession.get(row.sessionId) ?? [];
        records.push(parseUsageRecord(row.usageJson));
        rowsBySession.set(row.sessionId, records);
    }
    const activeSessions = new Set(
        database.agentDelegations
            .receiptsForSessions(sessionIds)
            .filter((receipt) => isDelegationActive(receipt))
            .map((receipt) => receipt.sessionId),
    );
    const children = new Map<
        string,
        { costUsd: number; isPartial: boolean; isActive: boolean; sessionCount: number }
    >();
    for (const [sessionId, branch] of branchOf) {
        const cost = sessionCostOf(rowsBySession.get(sessionId) ?? [], priceOf);
        const isActive = activeSessions.has(sessionId);
        if (!cost && !isActive) continue;
        const child = children.get(branch) ?? {
            costUsd: 0,
            isPartial: false,
            isActive: false,
            sessionCount: 0,
        };
        if (cost) {
            child.costUsd += cost.costUsd;
            child.isPartial ||= cost.isPartial;
            child.sessionCount += 1;
        }
        child.isActive ||= isActive;
        children.set(branch, child);
    }
    for (const branch of truncatedBranches) {
        const child = children.get(branch);
        if (child) child.isPartial = true;
    }
    // A branch that only has a running task and no usage yet stays in `children` (so its row keeps the `~` of a retry
    // that is still running) with a zero `sessionCount`; it adds nothing to the totals.
    const priced = children
        .entries()
        .filter(([, child]) => child.sessionCount > 0)
        .toArray();
    return {
        delegatedCostUsd: priced.reduce((sum, [, child]) => sum + child.costUsd, 0),
        delegatedSessions: priced.reduce((sum, [, child]) => sum + child.sessionCount, 0),
        isPartial: isTruncated || priced.some(([, child]) => child.isPartial),
        isActive: children.values().some((child) => child.isActive),
        children: children
            .entries()
            .map(([sessionId, child]) => ({ sessionId, ...child }))
            .toArray(),
    };
}

/**
 * One Session's own all-time spend plus what the Sessions below it cost. The own figure is absent, with no zero put in
 * its place, when the Session's ledger rows hold no usage; `null` only when neither it nor a descendant has any.
 */
export function sessionCostWithDelegated(
    database: Pick<CaxriDatabase, 'agentDelegations' | 'agentSessionUsage'>,
    sessionId: string,
    priceOf: ModelPriceLookup,
): SessionCost | null {
    const own = sessionCostOf(
        database.agentSessionUsage
            .listForSession(sessionId)
            .map((row) => parseUsageRecord(row.usageJson)),
        priceOf,
    );
    const delegated = delegatedCost(database, sessionId, priceOf);
    if (!own && delegated.delegatedSessions === 0) return null;
    return {
        ...own,
        ...(delegated.delegatedSessions > 0 && {
            delegatedCostUsd: delegated.delegatedCostUsd,
            delegatedSessions: delegated.delegatedSessions,
            delegatedIsPartial: delegated.isPartial,
        }),
    };
}
