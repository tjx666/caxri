import type { DelegationWaitingOn, SessionRecord } from '@caxri/protocol';

import type { Translate } from '../../../i18n';

/**
 * What the composer's first strip row says in a Chat that another Session delegated its work to.
 */
export interface DelegationOrigin {
    /**
     * Whether the user already took this Session over (`takenOverAt` on the feed entry). Until then the row promises
     * the result goes back and warns that acting here ends that.
     */
    isTakenOver: boolean;
    /**
     * An archived parent stays named but cannot be opened: navigating to it never restores it.
     */
    isParentArchived: boolean;
    /**
     * Whether this Session's open question still waits on the delegating Agent (`waitingOn` is `parent`). Once it
     * escalates the row says it waits on the user instead, and the question card shows.
     */
    isWaitingOnParent: boolean;
    parent: Pick<SessionRecord, 'id' | 'title'>;
}

/**
 * The origin row for a delegated or consult child, or `undefined` when there is nothing to say: a hand-off carries the
 * work on and nothing returns, a Session the user or Caxri Bot created has no relation, and a parent that was deleted
 * (the creator fields are dropped) or sits in a hidden Project is not in `parent`.
 */
export function delegationOrigin(
    session: Pick<SessionRecord, 'createdByRelation'>,
    parent: Pick<SessionRecord, 'archivedAt' | 'id' | 'title'> | undefined,
    takenOverAt: number | undefined,
    waitingOn?: DelegationWaitingOn,
): DelegationOrigin | undefined {
    if (session.createdByRelation !== 'delegated' && session.createdByRelation !== 'consult')
        return undefined;
    if (!parent) return undefined;
    return {
        isParentArchived: parent.archivedAt !== undefined,
        isTakenOver: takenOverAt !== undefined,
        isWaitingOnParent: takenOverAt === undefined && waitingOn === 'parent',
        parent: { id: parent.id, title: parent.title },
    };
}

/**
 * The translation key of what a not-yet-taken-over origin row says after the parent's name. A question and a permission
 * request word the same three states (the result returns on its own, the Agent that delegated this is deciding, the
 * decision is the user's), so the row never calls a question an approval.
 */
export function originReturnNoteKey({
    hasApproval,
    isEscalated,
    isWaitingOnParent,
}: {
    hasApproval: boolean;
    isEscalated: boolean;
    isWaitingOnParent: boolean;
}): Parameters<Translate>[0] {
    if (isEscalated)
        return hasApproval
            ? 'delegation.origin.waitingForYourApproval'
            : 'delegation.origin.waitingForYou';
    if (isWaitingOnParent)
        return hasApproval
            ? 'delegation.origin.waitingForApproval'
            : 'delegation.origin.waitingForParent';
    return 'delegation.origin.autoReturn';
}
