import type { ProjectRecord, SessionRecord } from '@caxri/protocol';
import { compareSessionSidebarOrder, isPinnedSession } from '@caxri/protocol';

import {
    PINNED_GROUP_ROW_ID,
    primarySidebarDelegatedRowId,
    primarySidebarPinnedRowId,
} from '../primary-sidebar-tree';

/**
 * Where the Project tree puts one Session.
 *
 * - `row`: an ordinary top-level row, in its own Project group or (when pinned) the Pinned group.
 * - `nested`: a level-3 row under its host: a `delegated` Session, or a hidden consult while it is the selected Session.
 * - `hidden`: a `consult` Session that has a listed ancestor, so it takes no row.
 *
 * A Session absent from {@link DelegatedPlacement.byId} has no row at all: it is archived, or its Project is not shown
 * and it is not pinned.
 */
type SessionPlacement =
    { kind: 'row' } | { hostId: string; kind: 'nested' } | { hostId: string; kind: 'hidden' };

export interface DelegatedPlacement {
    /**
     * Placement of every Session that has a place in the tree (see {@link SessionPlacement}).
     */
    readonly byId: ReadonlyMap<string, SessionPlacement>;
    /**
     * The group (a Project id, or `PINNED_GROUP_ROW_ID`) that holds the host of each `nested` and `hidden` Session,
     * keyed by Session id. This is where the Session counts for rollups and auto-collapse protection; the Session's own
     * `projectId` is never rewritten.
     */
    readonly groupIdBySessionId: ReadonlyMap<string, string>;
    /**
     * The nested and hidden Sessions each group holds through its hosts, in no particular order. A collapsed group's
     * heading folds these into its status counts.
     */
    readonly hostedByGroup: ReadonlyMap<string, readonly SessionRecord[]>;
    /**
     * Hidden consults per host, in sidebar order. They have no row; the palette still finds them.
     */
    readonly hiddenByHost: ReadonlyMap<string, readonly SessionRecord[]>;
    /**
     * Nested Sessions per host, in sidebar order. Always one level: a Session created by a nested Session is listed
     * under the nested Session's host.
     */
    readonly nestedByHost: ReadonlyMap<string, readonly SessionRecord[]>;
    /**
     * Sessions with an ordinary row, in the order they came in. The Project groups and the Pinned group are built from
     * these alone.
     */
    readonly rows: readonly SessionRecord[];
}

interface PlaceDelegatedSessionsInput {
    /**
     * Delegated Sessions the user has taken over and not handed back (`control: 'human'` in the delegation feed). Such
     * a Session answers to the user rather than to its creator, so it takes an ordinary row and hosts what it
     * delegates. Omitted by callers that order Sessions without the feed (previous/next Session, the palette).
     */
    humanControlledSessionIds?: ReadonlySet<string>;
    /**
     * The Projects the tree lists. A Session of any other Project has a row only through the Pinned group.
     */
    projects: ReadonlyArray<Pick<ProjectRecord, 'id'>>;
    selectedSessionId: string | undefined;
    /**
     * Every Session record, archived ones included: an archived creator is how a chain breaks.
     */
    sessions: readonly SessionRecord[];
}

/**
 * The longest creator chain the walk follows. Real chains are two or three deep; the cap only keeps a corrupt record
 * set from turning one Session's placement into a long loop.
 */
const MAX_CREATOR_WALK = 16;

/**
 * Whether a Session wants to nest under an ancestor. `consult` always does (it is hidden while an ancestor is listed),
 * `delegated` does unless it is pinned or the user controls it: a pinned, non-hidden Session is a flat row in the
 * Pinned group, and a taken-over one is the user's own Session until they hand it back. A Session without
 * `createdBySessionId` never does, whatever its relation says: the read model drops the creator when it is deleted, and
 * a Session with no creator is an ordinary row.
 */
function shouldNest(session: SessionRecord, humanControlled: ReadonlySet<string>): boolean {
    if (session.createdBySessionId === undefined) return false;
    if (session.createdByRelation === 'consult') return true;
    return (
        session.createdByRelation === 'delegated' &&
        !isPinnedSession(session) &&
        !humanControlled.has(session.id)
    );
}

const NO_SESSION_IDS: ReadonlySet<string> = new Set();

/**
 * Resolves the host of `session`: the nearest ancestor along `createdBySessionId` that is a top-level listed row, or
 * `undefined` when there is none and the Session is an ordinary row.
 *
 * The walk climbs only through Sessions that themselves nest (a nested delegated Session, a hidden consult), so a chain
 * flattens onto one host. It ends at the first creator that is missing (deleted, or the link was cleared) or archived,
 * at one that takes an ordinary row (handoff, independent, no relation, a pinned delegated Session, a delegated Session
 * whose own chain is broken), and at a cycle or the depth cap; the last two leave the Session ordinary so no row can
 * disappear. An archived creator breaks the chain on purpose, like a deleted one: archiving a Session returns what it
 * created to their own Projects.
 */
function resolveHostId(
    session: SessionRecord,
    sessionsById: ReadonlyMap<string, SessionRecord>,
    hasRow: (session: SessionRecord) => boolean,
    humanControlled: ReadonlySet<string>,
): string | undefined {
    /**
     * Creators nearest first; the last entry is the top of the chain the walk reached.
     */
    const creators: SessionRecord[] = [];
    const seen = new Set([session.id]);
    let current = session;
    while (current.createdBySessionId !== undefined) {
        const creator = sessionsById.get(current.createdBySessionId);
        if (creator === undefined || creator.archivedAt !== undefined) break;
        if (seen.has(creator.id) || creators.length >= MAX_CREATOR_WALK) return undefined;
        seen.add(creator.id);
        creators.push(creator);
        if (!shouldNest(creator, humanControlled)) break;
        current = creator;
    }
    /**
     * Top-down: the top of the chain has no host above it; each Session below inherits the host of the one above it, or
     * takes that one as its host when it holds a row of its own.
     */
    let host: string | undefined;
    let above: SessionRecord | undefined;
    for (const link of [...creators.toReversed(), session]) {
        host = above === undefined ? undefined : (host ?? (hasRow(above) ? above.id : undefined));
        above = link;
    }
    return host;
}

function appendTo<Key, Value>(map: Map<Key, Value[]>, key: Key, value: Value): void {
    const bucket = map.get(key);
    if (bucket) bucket.push(value);
    else map.set(key, [value]);
}

/**
 * The group whose row holds a top-level Session: the Pinned group for a pinned one, else its own Project.
 */
function sessionRowGroupId(session: Pick<SessionRecord, 'pinnedAt' | 'projectId'>): string {
    return isPinnedSession(session) ? PINNED_GROUP_ROW_ID : session.projectId;
}

/**
 * Decides, from Session records and the user's takeovers, which Sessions get an ordinary row and which nest under a
 * host or disappear as a hidden consult. Nothing else from the delegation feed counts: a row must not move because a
 * task failed, only because the user took the Session over or handed it back.
 *
 * - `delegated` nests under its host unless the user took it over; `consult` takes no row while it has a host, except the
 *   selected one, which nests so the selection stays visible; `handoff`, `independent` and Sessions with no relation
 *   are ordinary rows.
 * - A host must hold a row itself: a Session whose Project is not shown and which is not pinned is not listed, so what it
 *   created stays an ordinary row in its own Project and nothing becomes unreachable.
 * - Consult hiding applies before pin placement, so a pinned hidden consult stays hidden.
 */
export function placeDelegatedSessions({
    humanControlledSessionIds = NO_SESSION_IDS,
    projects,
    selectedSessionId,
    sessions,
}: PlaceDelegatedSessionsInput): DelegatedPlacement {
    const listedProjectIds = new Set(projects.map((project) => project.id));
    const sessionsById = new Map(sessions.map((session) => [session.id, session]));
    const hasRow = (session: SessionRecord): boolean =>
        isPinnedSession(session) || listedProjectIds.has(session.projectId);
    const byId = new Map<string, SessionPlacement>();
    const rows: SessionRecord[] = [];
    const nested = new Map<string, SessionRecord[]>();
    const hidden = new Map<string, SessionRecord[]>();
    const activeSessions = sessions.filter((candidate) => candidate.archivedAt === undefined);
    for (const session of activeSessions) {
        const hostId = shouldNest(session, humanControlledSessionIds)
            ? resolveHostId(session, sessionsById, hasRow, humanControlledSessionIds)
            : undefined;
        if (hostId === undefined) {
            if (hasRow(session)) {
                byId.set(session.id, { kind: 'row' });
                rows.push(session);
            }
        } else if (session.createdByRelation === 'consult' && session.id !== selectedSessionId) {
            byId.set(session.id, { hostId, kind: 'hidden' });
            appendTo(hidden, hostId, session);
        } else {
            byId.set(session.id, { hostId, kind: 'nested' });
            appendTo(nested, hostId, session);
        }
    }
    for (const bucket of nested.values()) bucket.sort(compareSessionSidebarOrder);
    for (const bucket of hidden.values()) bucket.sort(compareSessionSidebarOrder);
    const groupIdBySessionId = new Map<string, string>();
    const hostedByGroup = new Map<string, SessionRecord[]>();
    for (const bucket of [nested, hidden]) {
        for (const [hostId, hosted] of bucket) {
            const host = sessionsById.get(hostId);
            const groupId = host === undefined ? undefined : sessionRowGroupId(host);
            if (groupId !== undefined) {
                for (const session of hosted) {
                    groupIdBySessionId.set(session.id, groupId);
                    appendTo(hostedByGroup, groupId, session);
                }
            }
        }
    }
    return {
        byId,
        groupIdBySessionId,
        hiddenByHost: hidden,
        hostedByGroup,
        nestedByHost: nested,
        rows,
    };
}

/**
 * The host a Session renders under, or `undefined` for an ordinary row, a hidden consult, and a Session with no row.
 */
export function nestedHostId(
    placement: Pick<DelegatedPlacement, 'byId'>,
    sessionId: string | undefined,
): string | undefined {
    const placed = sessionId === undefined ? undefined : placement.byId.get(sessionId);
    return placed?.kind === 'nested' ? placed.hostId : undefined;
}

/**
 * Every Session that renders as a nested row, in no particular order.
 */
export function nestedSessions(
    placement: Pick<DelegatedPlacement, 'nestedByHost'>,
): SessionRecord[] {
    return placement.nestedByHost.values().toArray().flat();
}

/**
 * The row id a top-level Session carries: namespaced inside the Pinned group, its Session id elsewhere.
 */
function topLevelRowId(hostId: string, groupId: string | undefined): string {
    return groupId === PINNED_GROUP_ROW_ID ? primarySidebarPinnedRowId(hostId) : hostId;
}

/**
 * Where `session.rename`, the selection reveal, and the pin reveal have to go to reach a Session's row: the group to
 * open and the row to scroll to.
 *
 * - A pinned Session's row is the namespaced one in the Pinned group.
 * - A nested Session opens its host's group (which is the Pinned group for a pinned host, not the nested Session's own
 *   Project) and addresses the nested row.
 * - A hidden consult has no row; its host's row is the closest place it lives.
 */
export function sessionRevealTarget(
    placement: Pick<DelegatedPlacement, 'byId' | 'groupIdBySessionId'>,
    session: Pick<SessionRecord, 'id' | 'pinnedAt' | 'projectId'>,
): { groupId: string; rowId: string } {
    const placed = placement.byId.get(session.id);
    if (placed === undefined || placed.kind === 'row') {
        const groupId = sessionRowGroupId(session);
        return { groupId, rowId: topLevelRowId(session.id, groupId) };
    }
    const groupId = placement.groupIdBySessionId.get(session.id) ?? session.projectId;
    return {
        groupId,
        rowId:
            placed.kind === 'nested'
                ? primarySidebarDelegatedRowId(session.id)
                : topLevelRowId(placed.hostId, groupId),
    };
}

/**
 * The rows the roving Tab stop falls back to, in order, when the selected Session is nested (or a selected hidden
 * consult placed under a host) and has no row on screen because its host's group is collapsed: the host's row, then the
 * host's group heading. Empty for a Session with an ordinary row, which has its own fallbacks.
 */
export function selectedHostFallbackRowIds(
    placement: Pick<DelegatedPlacement, 'byId' | 'groupIdBySessionId'>,
    selectedSessionId: string | undefined,
): string[] {
    const placed =
        selectedSessionId === undefined ? undefined : placement.byId.get(selectedSessionId);
    if (selectedSessionId === undefined || placed === undefined || placed.kind === 'row') return [];
    const groupId = placement.groupIdBySessionId.get(selectedSessionId);
    return groupId === undefined
        ? [placed.hostId]
        : [topLevelRowId(placed.hostId, groupId), groupId];
}
