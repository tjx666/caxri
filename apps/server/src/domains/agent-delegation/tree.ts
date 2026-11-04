import type { SessionRelation } from '@caxri/protocol';

import type { CaxriDatabase } from '../db';

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
 * something). A hand-off moves the user's own continuation to another Session, and an independent Session is the
 * creator's separate task that it does not wait on, so neither is delegated spend or attention of the creator.
 */
const ROLLED_UP_RELATIONS: readonly SessionRelation[] = ['delegated', 'consult'];

/**
 * What {@link delegatedDescendants} found below a root. `parentOf` and `relationOf` give the creating Session and the
 * relation of each descendant's edge.
 */
export interface DelegatedTree {
    branchOf: Map<string, string>;
    parentOf: Map<string, string>;
    relationOf: Map<string, SessionRelation>;
    isTruncated: boolean;
    truncatedBranches: Set<string>;
}

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
): DelegatedTree {
    const { history } = database.agentDelegations;
    const branchOf = new Map<string, string>();
    const parentOf = new Map<string, string>();
    const relationOf = new Map<string, SessionRelation>();
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
        for (const { sessionId, parentSessionId, relation } of edges.slice(0, remaining)) {
            branchOf.set(
                sessionId,
                parentSessionId === rootSessionId ? sessionId : branchOf.get(parentSessionId)!,
            );
            parentOf.set(sessionId, parentSessionId);
            relationOf.set(sessionId, relation);
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
    return { branchOf, parentOf, relationOf, isTruncated, truncatedBranches };
}
