import type { DelegationCostSummary, SessionCost } from '@caxri/protocol';
import { isDelegationActive } from '@caxri/protocol';

import { delegatedDescendants } from '../agent-delegation';
import type { CaxriDatabase } from '../db';
import { parseUsageRecord } from './record';
import type { ModelPriceLookup } from './summary';
import { sessionCostOf } from './summary';

type DelegatedCost = Omit<DelegationCostSummary, 'isScanPending'>;

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
