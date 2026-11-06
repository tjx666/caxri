/**
 * The fields the cross-field rules of a delegation request read. Shared by the stored and the request schema so both
 * enforce one rule set.
 */
export type DelegationCreateShape = Partial<
    Record<
        | 'continueFromHandover'
        | 'effort'
        | 'followUpOf'
        | 'model'
        | 'preset'
        | 'provider'
        | 'resumeFrom'
        | 'surface'
        | 'type',
        unknown
    >
>;

export const isOneContinuation = (value: DelegationCreateShape) =>
    [value.followUpOf, value.resumeFrom, value.continueFromHandover].filter(Boolean).length <= 1;
/**
 * A preset owns its provider, model and effort, and is never combined with a type. A type picks its Agent from Settings
 * unless the request names a provider (with optional model and effort), which a fresh retry on another Agent and a user
 * who names one rely on.
 */
export const isPresetExclusive = (value: DelegationCreateShape) =>
    !value.preset || (!value.type && !value.provider && !value.model && !value.effort);
/**
 * A model or effort without a provider applies to a type's bound Agent only when the request names that Agent.
 */
export const isTypeLaunchNamed = (value: DelegationCreateShape) =>
    !value.type || Boolean(value.provider) || (!value.model && !value.effort);
export const isSurfaceForNewTask = (value: DelegationCreateShape) =>
    !value.surface || (!value.followUpOf && !value.resumeFrom && !value.continueFromHandover);
export const hasLaunchSource = (value: DelegationCreateShape) =>
    Boolean(
        value.provider ??
        value.preset ??
        value.type ??
        value.followUpOf ??
        value.resumeFrom ??
        value.continueFromHandover,
    );
/**
 * A hand-over continues an existing conversation, whose provider and launch are already fixed.
 */
export const isHandoverSelectionFree = (value: DelegationCreateShape) =>
    !value.continueFromHandover ||
    (!value.provider && !value.preset && !value.type && !value.model && !value.effort);

/**
 * The fields the Session relation rules read; a request names at most one relation and only with a new Session.
 */
type DelegationRelationShape = Partial<
    Record<'consult' | 'handoff' | 'independent' | 'newSession', unknown>
>;

export const isOneRelation = (value: DelegationRelationShape) =>
    [value.handoff, value.consult, value.independent].filter(Boolean).length <= 1;
export const isRelationForNewSession = (value: DelegationRelationShape) =>
    ![value.handoff, value.consult, value.independent].some(Boolean) || Boolean(value.newSession);

/**
 * A type starts its own new Session and decides that Session's relation, so it takes no relation flag and no worktree.
 */
export const isTypeForNewSession = (
    value: DelegationRelationShape & Partial<Record<'type' | 'worktreeBranch', unknown>>,
) =>
    !value.type ||
    (Boolean(value.newSession) &&
        ![value.handoff, value.consult, value.independent, value.worktreeBranch].some(Boolean));
