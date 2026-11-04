import type { DelegationControl, DelegationWaitingOn, SessionRecord } from '@caxri/protocol';

import type { Translate } from '../../../i18n';

/**
 * What the composer's first strip row says in a Chat that another Session delegated its work to.
 */
export interface DelegationOrigin {
    /**
     * Whether the Session is the user's now: taken over and not (yet) taken up again by the Agent that delegated it.
     * Until then the row promises the result goes back and warns that acting here ends that.
     */
    isTakenOver: boolean;
    /**
     * Who the Session answers to; `handback_pending` while the user's hand-back waits for the delegating Agent to use
     * it.
     */
    control: DelegationControl;
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
    feedControl?: DelegationControl,
): DelegationOrigin | undefined {
    if (session.createdByRelation !== 'delegated' && session.createdByRelation !== 'consult')
        return undefined;
    if (!parent) return undefined;
    // An entry without `control` was never handed back, so a takeover still means the user holds the Session.
    const control = feedControl ?? (takenOverAt === undefined ? 'delegated' : 'human');
    return {
        control,
        isParentArchived: parent.archivedAt !== undefined,
        isTakenOver: control !== 'delegated',
        isWaitingOnParent: control === 'delegated' && waitingOn === 'parent',
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

/**
 * Why the hand-back button is shown but disabled, in the order the row checks them: the delegating Agent's Session is
 * archived (nothing runs there to continue), this Chat is working or has queued messages, or the user has typed a
 * message they have not sent. `draft` exists only here: the Server never sees the composer, so it cannot refuse for
 * it.
 */
export type HandBackBlock = 'busy' | 'draft' | 'parent_archived';

/**
 * What the origin row shows for handing the Session back.
 */
export type HandBackView =
    { kind: 'hidden' } | { kind: 'pending' } | { kind: 'available'; block?: HandBackBlock };

/**
 * The hand-back part of the origin row: nothing while the Session is still delegated, a waiting note once the user
 * handed it back, and otherwise a button that is disabled with its reason while handing back could not work.
 */
export function handBackView(
    origin: Pick<DelegationOrigin, 'control' | 'isParentArchived'>,
    composer: { hasDraft: boolean; isBusy: boolean },
): HandBackView {
    if (origin.control === 'delegated') return { kind: 'hidden' };
    if (origin.control === 'handback_pending') return { kind: 'pending' };
    if (origin.isParentArchived) return { kind: 'available', block: 'parent_archived' };
    if (composer.isBusy) return { kind: 'available', block: 'busy' };
    if (composer.hasDraft) return { kind: 'available', block: 'draft' };
    return { kind: 'available' };
}

/**
 * The translation key of a disabled hand-back button's reason.
 */
export const HAND_BACK_BLOCK_KEYS = {
    busy: 'delegation.origin.handBackBlocked.busy',
    draft: 'delegation.origin.handBackBlocked.draft',
    parent_archived: 'delegation.origin.handBackBlocked.parent_archived',
} as const satisfies Record<HandBackBlock, Parameters<Translate>[0]>;
