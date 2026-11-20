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
 * Creator work whose creator is archived has no row either, matching Desktop's Projects tree (issues #3847 and #4067):
 * it was put away with the Session the user archived, and search still finds it. A delegated one waiting on the user
 * still keeps its row.
 *
 * The Server ranks the dashboard by this rule before its cap, and the phone filters by it, so a second opinion the list
 * will hide never takes the place of a row it would show.
 */
export const isSessionListedOnMobileHome = (
    session: MobileSessionHomeListingFacts,
    listedSessionIds: ReadonlySet<string>,
): boolean => {
    if (
        session.createdBySessionArchived === true &&
        !isPinnedSession(session) &&
        (session.createdByRelation === 'consult' || session.createdByRelation === 'delegated')
    )
        return session.createdByRelation === 'delegated' && isWaitingOnUser(session);
    const creatorId = session.createdBySessionId;
    if (creatorId === undefined || !listedSessionIds.has(creatorId)) return true;
    const isCreatorWork =
        session.createdByRelation === 'consult' ||
        (session.createdByRelation === 'delegated' && !isPinnedSession(session));
    return !isCreatorWork || isWaitingOnUser(session);
};

function isWaitingOnUser(session: MobileSessionHomeListingFacts): boolean {
    return (
        session.agentActivityState === 'waiting' ||
        (session.hasPendingAttention && session.lastAttentionKind === 'waiting')
    );
}
