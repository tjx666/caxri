import type { SessionRecord } from '../domain/domain.js';
import { isPinnedSession } from '../domain/session-order.js';

/**
 * The facts the phone's home list reads to decide whether a Session gets a row of its own.
 */
export type MobileSessionHomeListingFacts = Pick<
    SessionRecord,
    | 'agentActivityState'
    | 'createdByRelation'
    | 'createdBySessionId'
    | 'hasPendingAttention'
    | 'lastAttentionKind'
    | 'pinnedAt'
> & {
    /**
     * Whether the Session's creator is archived, which the dashboard projects because the phone does not receive
     * archived Sessions.
     */
    createdBySessionArchived?: boolean;
};

/**
 * Whether the phone's home list gives a Session a row. The phone has no room for Desktop's nested rows under the
 * Session that created another, so it leaves that work out instead: a `consult` Session (a second opinion) or an
 * unpinned `delegated` one whose creator the list holds belongs to the creator, and the creator's timeline still links
 * to it. A Session whose creator is absent (deleted or past the dashboard cap) keeps its row so nothing becomes
 * unreachable, and so does one waiting on the user's answer, which the phone must not hide.
 *
 * An unpinned `consult` Session whose creator is archived has no row, matching Desktop's Projects tree (issue #3847):
 * the answer belonged to a Session the user put away, and search still finds it.
 *
 * The Server ranks the dashboard by this rule before its cap, and the phone filters by it, so a second opinion the list
 * will hide never takes the place of a row it would show.
 */
export const isSessionListedOnMobileHome = (
    session: MobileSessionHomeListingFacts,
    listedSessionIds: ReadonlySet<string>,
): boolean => {
    if (
        session.createdByRelation === 'consult' &&
        session.createdBySessionArchived === true &&
        !isPinnedSession(session)
    )
        return false;
    const creatorId = session.createdBySessionId;
    if (creatorId === undefined || !listedSessionIds.has(creatorId)) return true;
    const isCreatorWork =
        session.createdByRelation === 'consult' ||
        (session.createdByRelation === 'delegated' && !isPinnedSession(session));
    if (!isCreatorWork) return true;
    return (
        session.agentActivityState === 'waiting' ||
        (session.hasPendingAttention && session.lastAttentionKind === 'waiting')
    );
};
