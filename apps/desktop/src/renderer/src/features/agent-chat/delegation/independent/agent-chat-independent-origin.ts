import type { SessionRecord } from '@caxri/protocol';

/**
 * Where an independent Session came from: the Session whose Agent started it for its own task.
 */
export interface IndependentOrigin {
    /**
     * An archived creator stays named but cannot be opened: navigating to it never restores it.
     */
    isParentArchived: boolean;
    parent: Pick<SessionRecord, 'id' | 'title'>;
}

/**
 * The origin line of an `independent` Session, or `undefined` when there is nothing to say: any other relation, or a
 * creator that was deleted or sits in a hidden Project (it is not in `parent`). Unlike a delegated child's origin it
 * promises no return, warns of no takeover and offers no hand-back, because the creator does not wait for the Session
 * and the user already owns it.
 */
export function independentOrigin(
    session: Pick<SessionRecord, 'createdByRelation'>,
    parent: Pick<SessionRecord, 'archivedAt' | 'id' | 'title'> | undefined,
): IndependentOrigin | undefined {
    if (!parent || session.createdByRelation !== 'independent') return undefined;
    return {
        isParentArchived: parent.archivedAt !== undefined,
        parent: { id: parent.id, title: parent.title },
    };
}
